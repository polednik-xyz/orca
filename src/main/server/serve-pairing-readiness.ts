import type { RuntimeDeviceGrant } from '../runtime/rpc/callers/rpc-method-permission'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { resolveAdvertisedPairingEndpoint } from '../runtime/rpc/server/pairing/network/pairing-endpoint'
import { assertServeProjectRoot, renderServePairingQr } from './serve-pairing-output'
import { createServeRelayPairingOffer } from './serve-relay-pairing'
import type { ServeReadiness, ServeReadinessOutput } from './serve-readiness'

export async function buildServePairingReadiness(
  options: {
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
    relay?: boolean
    grantDesktopControl?: boolean
  },
  rpc: Pick<
    OrcaRuntimeRpcServer,
    'getWebSocketEndpoint' | 'createPairingOffer' | 'createRuntimeRelayPairingOffer'
  >
): Promise<Pick<ServeReadiness, 'boundEndpoint' | 'advertisedEndpoint' | 'pairing'>> {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const name = `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`
  const grants: readonly RuntimeDeviceGrant[] = options.grantDesktopControl
    ? ['desktop-control']
    : []
  const relayOffer =
    options.relay && !options.noPairing && !options.mobilePairing
      ? await createServeRelayPairingOffer(rpc, { address: options.pairingAddress, name, grants })
      : null
  const offer = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : (relayOffer ??
      rpc.createPairingOffer({
        address: options.pairingAddress,
        name,
        scope: options.mobilePairing ? 'mobile' : 'runtime',
        grants
      }))

  return {
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    pairing: offer.available
      ? {
          available: true,
          url: offer.pairingUrl,
          endpoint: offer.endpoint,
          deviceId: offer.deviceId,
          webClientUrl: offer.webClientUrl,
          scope: options.mobilePairing ? 'mobile' : 'runtime',
          qr: options.mobilePairing ? await renderServePairingQr(offer.pairingUrl) : null,
          ...(relayOffer?.available ? { relay: relayOffer.relay } : {})
        }
      : offer
  }
}

export function servePublishMode(options: {
  recipeJson?: boolean
  projectRoot?: string | null
  json?: boolean
}): ServeReadinessOutput {
  return options.recipeJson && options.projectRoot
    ? { mode: 'recipe-json', projectRoot: assertServeProjectRoot(options.projectRoot) }
    : { mode: options.json ? 'json' : 'human' }
}
