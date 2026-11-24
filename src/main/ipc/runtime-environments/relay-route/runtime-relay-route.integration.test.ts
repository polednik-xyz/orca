import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { DeviceCredentialInstalled } from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import type { PairingOffer } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { deriveRelayHostId } from '../../../runtime/mobile-cloud-relay/director/relay-http-client'
import { OrchestrationDb } from '../../../runtime/orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../../runtime/rpc/server/runtime-rpc'
import { CloudRelayTransport } from '../../../runtime/rpc/transports/relay-transport'
import { RuntimeRelayBridge } from './runtime-relay-bridge'
import {
  hashRuntimeRelayCredential,
  pairRuntimeEnvironmentThroughRelay
} from './runtime-relay-pairing'
import type { RuntimeRelayRoute } from './runtime-relay-route-store'

const DAY_MS = 24 * 60 * 60 * 1000
const INVITE_TOKEN = 'I'.repeat(43)

type Harness = Awaited<ReturnType<typeof startHarness>>

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

function forward(target: WebSocket, raw: RawData, isBinary: boolean): void {
  if (target.readyState === target.OPEN) {
    target.send(raw, { binary: isBinary })
  }
}

function tcpPort(address: AddressInfo | string | null): number {
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  return address.port
}

async function startRuntimeServer(): Promise<OrcaRuntimeRpcServer> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-relay-route-'))
  cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
  const runtime = new OrcaRuntimeService()
  // Why: revoking touches the orchestration DB; on disk it would lock the harness userData on Windows.
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    db.close()
  })
  return server
}

/** Fronts `endpoint` with a TCP proxy that counts dials, to see which route a request tried. */
async function countingProxy(endpoint: string) {
  const target = new URL(endpoint)
  const counter = { dials: 0, endpoint: '' }
  const proxy = createTcpServer((socket) => {
    counter.dials += 1
    const upstream = connect(Number(target.port), target.hostname)
    socket.pipe(upstream).pipe(socket)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())))
  const proxied = new URL(endpoint)
  proxied.port = String(tcpPort(proxy.address()))
  counter.endpoint = proxied.toString()
  return counter
}

/** A runtime server behind a fake Relay cell that splices clients onto host data sockets. */
async function startHarness(options: { cellHonorsRevoke: boolean }) {
  const server = await startRuntimeServer()
  const cell = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  await new Promise<void>((resolve) => cell.once('listening', resolve))
  const cellPort = tcpPort(cell.address())
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of cell.clients) {
          client.terminate()
        }
        cell.close(() => resolve())
      })
  )
  const installs = new Map<string, DeviceCredentialInstalled>()
  const revokedDevices = new Set<string>()
  const state = { resumeHash: '', deviceId: '', clientConnections: 0, inviteSpent: false }
  const credentialAccepted = (credential: string): boolean =>
    hashRuntimeRelayCredential(credential) === state.resumeHash &&
    !(options.cellHonorsRevoke && revokedDevices.has(state.deviceId))

  const relayHostId = deriveRelayHostId(server.getE2EEKeypair()!.publicKey)
  const relayEndpoint = {
    v: 1 as const,
    directorUrl: 'https://director.relay.test',
    cellUrl: 'https://cell.relay.test',
    assignmentEpoch: 1,
    relayHostId,
    e2eeFraming: 2 as const
  }
  const connectUrl = (baseUrl: string, hostId: string) =>
    baseUrl === relayEndpoint.directorUrl
      ? `ws://127.0.0.1:${cellPort}/director/v1/connect/${hostId}`
      : `ws://127.0.0.1:${cellPort}/v1/connect/${hostId}`
  // Mirrors the real director: unknown or revoked resume tokens are 401.
  const director = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const token: unknown = JSON.parse(body).resumeToken
      const known = typeof token === 'string' && credentialAccepted(token)
      response.writeHead(known ? 200 : 401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          known
            ? { v: 1, cellUrl: relayEndpoint.cellUrl, assignmentEpoch: 1 }
            : { error: 'invalid_credential' }
        )
      )
    })
  })
  await new Promise<void>((resolve) => director.listen(0, '127.0.0.1', resolve))
  const directorUrl = `http://127.0.0.1:${tcpPort(director.address())}`
  cleanups.push(() => new Promise<void>((resolve) => director.close(() => resolve())))

  server.setMobileRelayPairingProvider({
    createPairingRelay: async (relayDeviceId) => {
      const inviteExpiresAt = Date.now() + 5 * 60_000
      return {
        relay: { ...relayEndpoint, inviteToken: INVITE_TOKEN, inviteExpiresAt },
        binding: { relayHostId, relayDeviceId, ownerIdentityKey: 'owner', inviteExpiresAt }
      }
    },
    onDeviceRevokeQueued: (item) => revokedDevices.add(item.relayDeviceId),
    getEndpoints: async (_context, params) => {
      const installed = params.installReqId ? installs.get(params.installReqId) : undefined
      return {
        v: 1,
        relay: relayEndpoint,
        ...(params.installReqId
          ? {
              installStatus: installed
                ? { v: 1, reqId: params.installReqId, state: 'committed', result: installed }
                : { v: 1, reqId: params.installReqId, state: 'not-found' }
            }
          : {})
      }
    },
    provisionRelay: async (_context, params) => {
      state.resumeHash = params.newResumeTokenHash
      const installed: DeviceCredentialInstalled = {
        v: 1,
        reqId: params.reqId,
        authorizationMode: 'relay-basis',
        currentVersion: 1,
        resumeExpiresAt: Date.now() + 30 * DAY_MS
      }
      installs.set(params.reqId, installed)
      return installed
    }
  })

  const transport = new CloudRelayTransport({
    cellUrl: `http://127.0.0.1:${cellPort}`,
    relayHostId,
    generation: 1
  })
  server.getMobileSocketWiring()!.attachTransport(transport, (ws) => transport.metadataFor(ws))
  await transport.start()
  cleanups.push(() => transport.stop())

  const pendingClients = new Map<string, { client: WebSocket; kind: 'invite' | 'resume' }>()
  let connectionSequence = 0
  cell.on('connection', (socket, request) => {
    socket.once('message', (raw) => {
      if (request.url?.startsWith('/v1/host/data/')) {
        const connId = decodeURIComponent(request.url.slice('/v1/host/data/'.length))
        const pending = pendingClients.get(connId)
        if (!pending) {
          socket.close(4401)
          return
        }
        pendingClients.delete(connId)
        socket.on('message', (data, isBinary) => forward(pending.client, data, isBinary))
        pending.client.on('message', (data, isBinary) => forward(socket, data, isBinary))
        socket.once('close', () => pending.client.close(4408))
        pending.client.once('close', () => socket.close())
        if (pending.kind === 'invite') {
          state.inviteSpent = true
        }
        const leaseExpiresAt = Date.now() + 60_000
        pending.client.send(
          JSON.stringify(
            pending.kind === 'invite'
              ? { type: 'relay-hello', ok: true, credentialKind: 'invite', leaseExpiresAt }
              : {
                  type: 'relay-hello',
                  ok: true,
                  credentialKind: 'resume',
                  leaseExpiresAt,
                  acceptedCredentialVersion: 1,
                  acceptedAs: 'current',
                  resumeExpiresAt: Date.now() + 30 * DAY_MS
                }
          )
        )
        return
      }
      const auth: unknown = JSON.parse(raw.toString())
      const credential =
        typeof auth === 'object' && auth !== null && 'credential' in auth
          ? String(auth.credential)
          : ''
      const inviteUsable = credential === INVITE_TOKEN && !state.inviteSpent
      // Why: only the director names a spent invite; the cell answers it like a moved host.
      if (request.url?.startsWith('/director/')) {
        socket.send(JSON.stringify({ type: 'relay-hello', ok: false, code: 4401 }))
        socket.close(4401)
        return
      }
      const kind = inviteUsable ? 'invite' : credentialAccepted(credential) ? 'resume' : null
      // Why 4409: a real cell cannot tell a revoked or spent credential from a moved host.
      if (!kind) {
        socket.send(JSON.stringify({ type: 'relay-hello', ok: false, code: 4409 }))
        socket.close(4409)
        return
      }
      state.clientConnections += 1
      const connId = `conn-${++connectionSequence}`
      pendingClients.set(connId, { client: socket, kind })
      void transport.openConnection({
        connId,
        connTicket: 'A'.repeat(43),
        kind,
        relayDeviceId: state.deviceId,
        attachDeadlineMs: 5_000
      })
    })
  })

  const offer = await server.createRuntimeRelayPairingOffer({ address: '127.0.0.1' })
  if (!offer.available || !offer.relay.available) {
    throw new Error('expected a runtime Relay pairing offer')
  }
  state.deviceId = offer.deviceId
  const relayOffer = parsePairingCode(offer.relay.pairingUrl)
  if (!relayOffer?.relay) {
    throw new Error('expected Relay metadata in the runtime pairing link')
  }
  return { server, state, connectUrl, directorUrl, offer, relayOffer, revokedDevices }
}

async function pairAndBridge(harness: Harness, directEndpoint: string | null = null) {
  const paired = await pairRuntimeEnvironmentThroughRelay(
    harness.relayOffer,
    harness.relayOffer.relay!,
    { connectUrl: harness.connectUrl }
  )
  if (!paired.ok) {
    throw new Error(`relay pairing failed: ${paired.message}`)
  }
  let route: RuntimeRelayRoute = {
    ...paired.route,
    endpoint: { ...paired.route.endpoint, directorUrl: harness.directorUrl }
  }
  const bridgeFor = (environmentId: string, endpoint: string | null) => {
    const bridge = new RuntimeRelayBridge({
      environmentId,
      deviceToken: paired.offer.deviceToken,
      hostPublicKeyB64: paired.offer.publicKeyB64,
      directEndpoint: endpoint,
      readRoute: () => route,
      writeRoute: (update) => {
        route = update(route)
      },
      connectUrl: harness.connectUrl
    })
    cleanups.push(() => bridge.dispose())
    const pairing: PairingOffer = {
      v: 2,
      endpoint: bridge.endpoint,
      deviceToken: paired.offer.deviceToken,
      publicKeyB64: bridge.publicKeyB64
    }
    return { bridge, pairing }
  }
  return { paired, bridgeFor, ...bridgeFor('env-relay', directEndpoint) }
}

function statusThrough(pairing: PairingOffer) {
  return sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
    pairedRuntimeConnectionFromOffer(pairing),
    'status.get',
    undefined,
    10_000,
    undefined,
    undefined,
    undefined,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
}

describe('runtime pairing through Orca Relay', () => {
  it('pairs from a Relay link, installs a credential only this client holds, and serves the client stack', async () => {
    const harness = await startHarness({ cellHonorsRevoke: true })
    const { paired, pairing } = await pairAndBridge(harness)

    expect(paired.runtimeStatus).toMatchObject({ deviceScope: 'runtime' })
    expect(hashRuntimeRelayCredential(paired.route.credential.token)).toBe(harness.state.resumeHash)
    expect(paired.route.credential.token).not.toBe(INVITE_TOKEN)
    await expect(statusThrough(pairing)).resolves.toMatchObject({
      ok: true,
      result: { deviceScope: 'runtime' }
    })
  }, 30_000)

  it('reports a grant the server revoked as unauthorized through Relay', async () => {
    const harness = await startHarness({ cellHonorsRevoke: false })
    const { pairing } = await pairAndBridge(harness)
    await expect(statusThrough(pairing)).resolves.toMatchObject({ ok: true })

    expect(harness.server.revokeRuntimeAccess(harness.offer.deviceId)).toBe(true)

    expect(harness.revokedDevices.has(harness.offer.deviceId)).toBe(true)
    await expect(statusThrough(pairing)).rejects.toMatchObject({ code: 'unauthorized' })
  }, 30_000)

  it('reports a revoked cloud credential as unauthorized once the director refuses it', async () => {
    const harness = await startHarness({ cellHonorsRevoke: true })
    const { pairing } = await pairAndBridge(harness)

    expect(harness.server.revokeRuntimeAccess(harness.offer.deviceId)).toBe(true)

    await expect(statusThrough(pairing)).rejects.toMatchObject({ code: 'unauthorized' })
  }, 30_000)

  it('uses the paired endpoint when it answers and Relay only when it does not', async () => {
    const harness = await startHarness({ cellHonorsRevoke: true })
    const direct = await pairAndBridge(harness, harness.server.getWebSocketEndpoint())
    const relayDialsAfterPairing = harness.state.clientConnections

    await expect(statusThrough(direct.pairing)).resolves.toMatchObject({ ok: true })
    expect(harness.state.clientConnections).toBe(relayDialsAfterPairing)
    expect(direct.bridge.activeRoute).toBe('direct')

    // Port 9 (discard) is closed on test hosts, so the direct attempt is refused quickly.
    const unreachable = direct.bridgeFor('env-unreachable-direct', 'ws://127.0.0.1:9')
    await expect(statusThrough(unreachable.pairing)).resolves.toMatchObject({ ok: true })
    expect(harness.state.clientConnections).toBeGreaterThan(relayDialsAfterPairing)
    expect(unreachable.bridge.activeRoute).toBe('relay')
  }, 30_000)

  it('falls back to Relay and stays there when the paired address reaches a different Orca server', async () => {
    const harness = await startHarness({ cellHonorsRevoke: true })
    const foreign = await countingProxy((await startRuntimeServer()).getWebSocketEndpoint()!)
    const { pairing, bridge } = await pairAndBridge(harness, foreign.endpoint)

    await expect(statusThrough(pairing)).resolves.toMatchObject({ ok: true })
    expect(bridge.activeRoute).toBe('relay')
    expect(foreign.dials).toBeGreaterThan(0)
    const foreignDialsAfterMiss = foreign.dials
    await expect(statusThrough(pairing)).resolves.toMatchObject({ ok: true })
    // Why: after a direct miss the bridge prefers Relay instead of retrying the foreign address.
    expect(foreign.dials).toBe(foreignDialsAfterMiss)
    expect(bridge.activeRoute).toBe('relay')
  }, 30_000)

  it('still reports a grant the paired server revoked as unauthorized on the direct route', async () => {
    const harness = await startHarness({ cellHonorsRevoke: false })
    const { pairing } = await pairAndBridge(harness, harness.server.getWebSocketEndpoint())
    await expect(statusThrough(pairing)).resolves.toMatchObject({ ok: true })

    expect(harness.server.revokeRuntimeAccess(harness.offer.deviceId)).toBe(true)

    await expect(statusThrough(pairing)).rejects.toMatchObject({ code: 'unauthorized' })
  }, 30_000)

  it('reports a spent invite as an invalid link instead of an unreachable server', async () => {
    const harness = await startHarness({ cellHonorsRevoke: true })
    await pairAndBridge(harness)

    await expect(
      pairRuntimeEnvironmentThroughRelay(harness.relayOffer, harness.relayOffer.relay!, {
        connectUrl: harness.connectUrl
      })
    ).resolves.toMatchObject({ ok: false, kind: 'access-link-invalid' })
  }, 30_000)
})
