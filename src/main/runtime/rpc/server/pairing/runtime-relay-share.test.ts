import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRelayPairing } from '../runtime-rpc-pairing-types'
import { createRuntimeRelayPairingUrl } from './runtime-relay-share'

const { getDefaultPairingAddress, readRelayAccountFailure } = vi.hoisted(() => ({
  getDefaultPairingAddress: vi.fn(),
  readRelayAccountFailure: vi.fn()
}))

vi.mock('./network/pairing-network-interfaces', () => ({ getDefaultPairingAddress }))
vi.mock('../../../mobile-cloud-relay/authentication/relay-account-failure', () => ({
  readRelayAccountFailure
}))

function server(relay: RuntimeRelayPairing) {
  return {
    getNetworkExposureBindHost: () => '127.0.0.1',
    ensureNetworkExposure: vi.fn(async () => {}),
    createRuntimeRelayPairingOffer: vi.fn(async () => ({
      available: true as const,
      pairingUrl: 'orca://pair?code=direct',
      endpoint: 'ws://192.168.1.10:6768',
      deviceId: 'runtime-1',
      webClientUrl: null,
      offerExpiresAt: 9_000,
      relay
    })),
    revokeRuntimeAccess: vi.fn(() => true)
  }
}

const minted: RuntimeRelayPairing = {
  available: true,
  pairingUrl: 'orca://pair?code=relay',
  inviteExpiresAt: 9_000
}
const lookup = async (): Promise<null> => null

describe('createRuntimeRelayPairingUrl', () => {
  beforeEach(() => {
    readRelayAccountFailure.mockResolvedValue(null)
    getDefaultPairingAddress.mockResolvedValue('192.168.1.10')
  })

  it('names the missing account step before creating any grant', async () => {
    readRelayAccountFailure.mockResolvedValue({ code: 'relay_sign_in_required', guidance: 'x' })
    const rpc = server(minted)
    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toEqual({
      available: false,
      reason: 'relay_sign_in_required',
      guidance: 'x'
    })
    expect(rpc.createRuntimeRelayPairingOffer).not.toHaveBeenCalled()
    expect(rpc.ensureNetworkExposure).not.toHaveBeenCalled()
  })

  it('revokes the grant instead of handing out a LAN-only link when the invite fails', async () => {
    const rpc = server({
      available: false,
      failure: { code: 'relay_control_not_active', stage: 'create_pairing_relay', message: 'x' }
    })
    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toMatchObject({
      available: false,
      reason: 'relay_control_not_active'
    })
    expect(rpc.revokeRuntimeAccess).toHaveBeenCalledWith('runtime-1')
  })

  it('shares through Relay alone without widening the listener when no LAN address exists', async () => {
    getDefaultPairingAddress.mockResolvedValue(null)
    const rpc = server(minted)
    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toMatchObject({
      available: true,
      pairingUrl: 'orca://pair?code=relay',
      inviteExpiresAt: 9_000
    })
    expect(rpc.ensureNetworkExposure).not.toHaveBeenCalled()
    expect(rpc.createRuntimeRelayPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: '127.0.0.1', reach: 'this-computer' })
    )
  })
})
