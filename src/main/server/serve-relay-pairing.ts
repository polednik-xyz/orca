import { readRelayAccountFailure } from '../runtime/mobile-cloud-relay/authentication/relay-account-failure'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import type {
  PairingOfferUnavailable,
  RuntimeRelayPairingOffer
} from '../runtime/rpc/server/runtime-rpc-pairing-types'
import type { RuntimeDeviceGrant } from '../runtime/rpc/callers/rpc-method-permission'
import type { ServeRelayPairingReadiness } from './serve-readiness'

export type ServeRelayPairingOffer = Omit<RuntimeRelayPairingOffer, 'relay'> & {
  relay: ServeRelayPairingReadiness
}

const SIGN_IN_GUIDANCE =
  'Sign this Orca profile in to an Orca account with Relay access (for example from the Orca desktop app on this machine), then restart orca serve --relay. The direct pairing link above still works.'

export async function createServeRelayPairingOffer(
  rpc: Pick<OrcaRuntimeRpcServer, 'createPairingOffer' | 'createRuntimeRelayPairingOffer'>,
  args: { address?: string | null; name: string; grants: readonly RuntimeDeviceGrant[] }
): Promise<PairingOfferUnavailable | ServeRelayPairingOffer> {
  const accountFailure = await readRelayAccountFailure(SIGN_IN_GUIDANCE)
  if (accountFailure) {
    const direct = rpc.createPairingOffer({ ...args, scope: 'runtime' })
    return direct.available ? { ...direct, relay: accountFailure } : direct
  }
  const offer = await rpc.createRuntimeRelayPairingOffer(args)
  if (!offer.available) {
    return offer
  }
  return {
    ...offer,
    relay: offer.relay.available
      ? {
          available: true,
          url: offer.relay.pairingUrl,
          inviteExpiresAt: offer.relay.inviteExpiresAt
        }
      : {
          available: false,
          code: offer.relay.failure.code,
          guidance: `${offer.relay.failure.message}. Check outbound HTTPS access to Orca Relay and restart orca serve --relay, or pair with the direct link.`
        }
  }
}
