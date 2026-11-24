import { afterEach, describe, expect, it, vi } from 'vitest'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { pairRuntimeEnvironmentThroughRelay } from './runtime-relay-pairing'

const NOW = Date.UTC(2026, 0, 1)

afterEach(() => {
  vi.useRealTimers()
})

describe('pairRuntimeEnvironmentThroughRelay', () => {
  it('refuses a link whose Relay host id does not derive from the pinned key, before dialing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const { publicKey } = NODE_PAIRED_E2EE_PRIMITIVES.generateKeyPair()
    const connectUrl = vi.fn(() => 'ws://127.0.0.1:1/unused')
    const result = await pairRuntimeEnvironmentThroughRelay(
      {
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: NODE_PAIRED_E2EE_PRIMITIVES.publicKeyToBase64(publicKey),
        scope: 'runtime'
      },
      {
        v: 1,
        directorUrl: 'https://relay.example.com',
        cellUrl: 'https://cell.example.com',
        assignmentEpoch: 1,
        relayHostId: 'AAAAAAAAAAAAAAAA',
        inviteToken: 'A'.repeat(43),
        inviteExpiresAt: NOW + 60_000,
        e2eeFraming: 2
      },
      { connectUrl }
    )
    expect(result).toMatchObject({ ok: false, kind: 'access-link-invalid' })
    expect(connectUrl).not.toHaveBeenCalled()
  })
})
