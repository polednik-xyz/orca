import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { MobileRelayPairingProvider } from './runtime-rpc-pairing-types'

const ownerIdentityKey = 'user\0profile\0org'
const NOW = Date.UTC(2026, 0, 1)
const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.example.com',
  cellUrl: 'https://cell.example.com',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  inviteToken: 'A'.repeat(43),
  inviteExpiresAt: NOW + 60_000,
  e2eeFraming: 2 as const
}

function relayProvider(
  overrides: Partial<MobileRelayPairingProvider> = {}
): MobileRelayPairingProvider {
  return {
    createPairingRelay: async (relayDeviceId) => ({
      relay,
      binding: {
        relayHostId: relay.relayHostId,
        relayDeviceId,
        ownerIdentityKey,
        inviteExpiresAt: relay.inviteExpiresAt
      }
    }),
    onDeviceRevokeQueued: vi.fn(),
    onDemandStateChanged: vi.fn(),
    getEndpoints: vi.fn(),
    provisionRelay: vi.fn(),
    ...overrides
  }
}

async function withServer(
  provider: MobileRelayPairingProvider | null,
  run: (server: OrcaRuntimeRpcServer) => Promise<void>
): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-relay-pairing-'))
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
  server.setMobileRelayPairingProvider(provider)
  await server.start()
  try {
    await run(server)
  } finally {
    await server.stop()
    db.close()
    rmSync(userDataPath, { recursive: true, force: true })
  }
}

async function relayOffer(server: OrcaRuntimeRpcServer) {
  const offer = await server.createRuntimeRelayPairingOffer({ address: '100.64.1.20' })
  if (!offer.available || !offer.relay.available) {
    throw new Error('expected a runtime Relay pairing offer')
  }
  return { ...offer, relay: offer.relay }
}

beforeEach(() => {
  // Why advancing: the real server runs on real timers; only the expiry clock is pinned.
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runtime-scoped Relay pairing', () => {
  it('binds the Relay invite to the same grant while the direct link stays Relay-free', async () => {
    await withServer(relayProvider(), async (server) => {
      const offer = await relayOffer(server)
      const direct = parsePairingCode(offer.pairingUrl)
      // Clients that predate runtime Relay reject a runtime offer carrying `relay`.
      expect(direct).not.toHaveProperty('relay')
      expect(parsePairingCode(offer.relay.pairingUrl)).toEqual({ ...direct, relay })
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)).toMatchObject({
        scope: 'runtime',
        relayBinding: { relayDeviceId: offer.deviceId, inviteExpiresAt: relay.inviteExpiresAt }
      })
    })
  })

  it('leaves the grant without a Relay binding when minting fails', async () => {
    const provider = relayProvider({
      createPairingRelay: vi.fn().mockRejectedValue(new Error('relay_control_not_active'))
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withServer(provider, async (server) => {
      const offer = await server.createRuntimeRelayPairingOffer({ address: '100.64.1.20' })
      if (!offer.available) {
        throw new Error('expected the direct runtime pairing offer')
      }
      expect(offer.relay).toMatchObject({ available: false })
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.relayBinding).toBeUndefined()
    })
  })

  it('revoking a Relay-enabled runtime grant queues its cloud credential revoke', async () => {
    const provider = relayProvider()
    await withServer(provider, async (server) => {
      const offer = await relayOffer(server)
      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)).toBeNull()
      expect(provider.onDeviceRevokeQueued).toHaveBeenCalledWith(
        expect.objectContaining({ relayDeviceId: offer.deviceId, relayHostId: relay.relayHostId })
      )
      expect(server.getRelayRevokeOutbox().pendingFor(ownerIdentityKey, relay.relayHostId)).toEqual(
        [expect.objectContaining({ relayDeviceId: offer.deviceId })]
      )
    })
  })

  it('revokes a direct-only runtime grant without a cloud revoke', async () => {
    const provider = relayProvider()
    await withServer(provider, async (server) => {
      const offer = server.createPairingOffer({ address: '100.64.1.20', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('expected a runtime pairing offer')
      }
      expect(server.revokeRuntimeAccess(offer.deviceId)).toBe(true)
      expect(provider.onDeviceRevokeQueued).not.toHaveBeenCalled()
    })
  })

  it('a newer link revokes the Relay invite of the unused grant it replaces', async () => {
    await withServer(relayProvider(), async (server) => {
      const first = await relayOffer(server)
      const next = server.createPairingOffer({
        address: '100.64.1.20',
        scope: 'runtime',
        rotate: true
      })
      expect(next).toMatchObject({ available: true })
      expect(server.getDeviceRegistry()?.getDevice(first.deviceId)).toBeNull()
      expect(server.getRelayRevokeOutbox().pendingFor(ownerIdentityKey, relay.relayHostId)).toEqual(
        [expect.objectContaining({ relayDeviceId: first.deviceId })]
      )
    })
  })
})
