import type { RuntimeRelayPairingUrlResult } from '../../../../../shared/remote-runtime/host-catalog/runtime-access-grants'
import { readRelayAccountFailure } from '../../../mobile-cloud-relay/authentication/relay-account-failure'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './network/network-exposure-guidance'
import {
  getDefaultPairingAddress,
  type DefaultRouteInterfaceLookup
} from './network/pairing-network-interfaces'
import { RUNTIME_RELAY_PAIRING_OFFER_TTL_MS } from './pairing-offer-expiry'

const LOOPBACK_ADDRESS = '127.0.0.1'

const SIGN_IN_GUIDANCE = 'Sign in to an Orca account to share this server through Orca Relay.'

const RELAY_MINT_FAILED_GUIDANCE =
  'Orca Relay could not create an invite. Check this computer’s internet connection and try again, or share over LAN or Tailscale.'

/** "Any network" share: a runtime grant whose link carries an Orca Relay invite next to the LAN address. */
export async function createRuntimeRelayPairingUrl(
  rpcServer: Pick<
    OrcaRuntimeRpcServer,
    | 'getNetworkExposureBindHost'
    | 'ensureNetworkExposure'
    | 'createRuntimeRelayPairingOffer'
    | 'revokeRuntimeAccess'
  >,
  lookup: DefaultRouteInterfaceLookup
): Promise<RuntimeRelayPairingUrlResult> {
  const accountFailure = await readRelayAccountFailure(SIGN_IN_GUIDANCE)
  if (accountFailure) {
    return { available: false, reason: accountFailure.code, guidance: accountFailure.guidance }
  }
  const lanAddress = await getDefaultPairingAddress(rpcServer.getNetworkExposureBindHost(), lookup)
  if (lanAddress) {
    try {
      await rpcServer.ensureNetworkExposure()
    } catch (error) {
      console.error('[mobile] Network exposure failed while creating a Relay runtime offer:', error)
      return {
        available: false,
        reason: 'network_exposure_failed',
        guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
      }
    }
  }
  const offer = await rpcServer.createRuntimeRelayPairingOffer({
    // Why: with no LAN or Tailscale address the link is Relay-only, and loopback needs no wider listener.
    address: lanAddress ?? LOOPBACK_ADDRESS,
    reach: lanAddress ? 'network' : 'this-computer',
    rotate: true,
    name: `Runtime ${new Date().toLocaleDateString()}`,
    offerTtlMs: RUNTIME_RELAY_PAIRING_OFFER_TTL_MS
  })
  if (!offer.available) {
    return { available: false, reason: offer.reason, guidance: offer.guidance }
  }
  if (!offer.relay.available) {
    // Why: an "any network" link must not silently be LAN-only, so drop the grant it would have used.
    rpcServer.revokeRuntimeAccess(offer.deviceId)
    return {
      available: false,
      reason: offer.relay.failure.code,
      guidance: RELAY_MINT_FAILED_GUIDANCE
    }
  }
  return {
    available: true,
    pairingUrl: offer.relay.pairingUrl,
    inviteExpiresAt: offer.relay.inviteExpiresAt,
    deviceId: offer.deviceId
  }
}
