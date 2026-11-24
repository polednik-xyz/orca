import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePairingCode } from '../../shared/remote-runtime/pairing/pairing'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RUNTIME_RELAY_PAIRING_OFFER_TTL_MS } from '../runtime/rpc/server/pairing/pairing-offer-expiry'
import { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import type { MobileRelayPairingProvider } from '../runtime/rpc/server/runtime-rpc-pairing-types'
import { createServeRelayPairingOffer } from './serve-relay-pairing'

vi.mock('../runtime/mobile-cloud-relay/authentication/relay-account-failure', () => ({
  readRelayAccountFailure: async () => null
}))

const NOW = Date.UTC(2026, 0, 1)

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.example.com',
  cellUrl: 'https://cell.example.com',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  inviteToken: 'A'.repeat(43),
  inviteExpiresAt: NOW + RUNTIME_RELAY_PAIRING_OFFER_TTL_MS,
  e2eeFraming: 2 as const
}

function relayProvider(
  createPairingRelay: MobileRelayPairingProvider['createPairingRelay']
): MobileRelayPairingProvider {
  return {
    createPairingRelay,
    onDeviceRevokeQueued: vi.fn(),
    onDemandStateChanged: vi.fn(),
    getEndpoints: vi.fn(),
    provisionRelay: vi.fn()
  }
}

async function withServer(
  provider: MobileRelayPairingProvider,
  run: (server: OrcaRuntimeRpcServer) => Promise<void>
): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-serve-relay-pairing-'))
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

const args = { address: '100.64.1.20', name: 'CLI', grants: [] }

beforeEach(() => {
  // Why frozen Date only: the real server runs on real timers while grant expiries read a fixed clock.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('orca serve --relay pairing', () => {
  it('mints the Relay link on its own 10-minute grant, never the direct one', async () => {
    const provider = relayProvider(async (relayDeviceId) => ({
      relay,
      binding: {
        relayHostId: relay.relayHostId,
        relayDeviceId,
        ownerIdentityKey: 'user\0profile\0org',
        inviteExpiresAt: relay.inviteExpiresAt
      }
    }))
    await withServer(provider, async (server) => {
      const offer = await createServeRelayPairingOffer(server, args)
      if (!offer.available || !offer.relay.available) {
        throw new Error('expected a serve Relay pairing offer')
      }
      const direct = parsePairingCode(offer.pairingUrl)
      const relayed = parsePairingCode(offer.relay.url)
      expect(relayed?.pairedDeviceId).not.toBe(direct?.pairedDeviceId)
      expect(relayed?.deviceToken).not.toBe(direct?.deviceToken)
      const registry = server.getDeviceRegistry()
      expect(registry?.getDevice(offer.deviceId)?.offerExpiresAt).toBeUndefined()
      const relayGrant = registry?.getDevice(relayed!.pairedDeviceId!)
      expect(relayGrant?.offerExpiresAt).toBe(NOW + RUNTIME_RELAY_PAIRING_OFFER_TTL_MS)
    })
  })

  it('revokes the Relay grant when minting fails and keeps the direct link', async () => {
    const createPairingRelay = vi.fn().mockRejectedValue(new Error('relay_control_not_active'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withServer(relayProvider(createPairingRelay), async (server) => {
      const offer = await createServeRelayPairingOffer(server, args)
      if (!offer.available) {
        throw new Error('expected the direct serve pairing offer')
      }
      expect(offer.relay).toMatchObject({ available: false })
      const [relayDeviceId] = createPairingRelay.mock.calls[0]
      expect(relayDeviceId).not.toBe(offer.deviceId)
      const registry = server.getDeviceRegistry()
      expect(registry?.getDevice(relayDeviceId)).toBeNull()
      expect(registry?.listDevices().map((d) => d.deviceId)).toEqual([offer.deviceId])
    })
  })
})
