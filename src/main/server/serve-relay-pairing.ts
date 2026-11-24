import { readRelayAccountFailure } from '../runtime/mobile-cloud-relay/authentication/relay-account-failure'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import type {
  PairingOfferUnavailable,
  RuntimeRelayPairingOffer
} from '../runtime/rpc/server/runtime-rpc-pairing-types'
import { RUNTIME_RELAY_PAIRING_OFFER_TTL_MS } from '../runtime/rpc/server/pairing/pairing-offer-expiry'
import type { RuntimeDeviceGrant } from '../runtime/rpc/callers/rpc-method-permission'
import type { ServeRelayPairingReadiness } from './serve-readiness'

export type ServeRelayPairingOffer = Omit<RuntimeRelayPairingOffer, 'relay'> & {
  relay: ServeRelayPairingReadiness
}

const SIGN_IN_GUIDANCE =
  'Sign this Orca profile in to an Orca account with Relay access (for example from the Orca desktop app on this machine), then restart orca serve --relay. The direct pairing link above still works.'

const MINT_FAILED_GUIDANCE =
  'Check outbound HTTPS access to Orca Relay and restart orca serve --relay, or pair with the direct link.'

export async function createServeRelayPairingOffer(
  rpc: Pick<
    OrcaRuntimeRpcServer,
    'createPairingOffer' | 'createRuntimeRelayPairingOffer' | 'revokeRuntimeAccess'
  >,
  args: { address?: string | null; name: string; grants: readonly RuntimeDeviceGrant[] }
): Promise<PairingOfferUnavailable | ServeRelayPairingOffer> {
  const direct = rpc.createPairingOffer({ ...args, scope: 'runtime' })
  if (!direct.available) {
    return direct
  }
  const accountFailure = await readRelayAccountFailure(SIGN_IN_GUIDANCE)
  if (accountFailure) {
    return { ...direct, relay: accountFailure }
  }
  // Why: its own expiring grant, so stripping `relay` from a leaked link never yields a lasting direct token.
  const offer = await rpc.createRuntimeRelayPairingOffer({
    ...args,
    offerTtlMs: RUNTIME_RELAY_PAIRING_OFFER_TTL_MS
  })
  if (!offer.available) {
    return {
      ...direct,
      relay: { available: false, code: offer.reason, guidance: offer.guidance }
    }
  }
  if (!offer.relay.available) {
    rpc.revokeRuntimeAccess(offer.deviceId)
    return {
      ...direct,
      relay: {
        available: false,
        code: offer.relay.failure.code,
        guidance: `${offer.relay.failure.message}. ${MINT_FAILED_GUIDANCE}`
      }
    }
  }
  return {
    ...direct,
    relay: {
      available: true,
      url: offer.relay.pairingUrl,
      inviteExpiresAt: offer.relay.inviteExpiresAt
    }
  }
}
