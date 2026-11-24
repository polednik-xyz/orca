import type { RuntimePairingReach } from '../../../../../../shared/remote-runtime/pairing/runtime-pairing-reach'

export const RUNTIME_PAIRING_LOOPBACK_ADDRESS = '127.0.0.1'

export type RuntimePairingIntent = 'another' | 'local' | 'custom' | 'relay'

// Only explicit local intent forbids network reach; custom loopback addresses may front SSH/reverse-proxy tunnels.
export function runtimePairingReachForIntent(intent: RuntimePairingIntent): RuntimePairingReach {
  return intent === 'local' ? 'this-computer' : 'network'
}

// Main retains pairing tokens; cache navigation state without persisting credential material.
export const runtimePairingLinkCache: {
  selectedAddress: string
  customAddress: string
  intent: RuntimePairingIntent
  generatedAddress: string | null
  runtimePairingUrl: string | null
  webClientUrl: string | null
  runtimePairingDeviceId: string | null
  grantStatus: 'unknown' | 'unused' | 'used' | 'removed'
  expiresAt: number | null
  /** The link carries an Orca Relay invite; a direct link never stands in for it, or the reverse. */
  generatedViaRelay: boolean
} = {
  selectedAddress: '',
  customAddress: '',
  intent: 'another',
  generatedAddress: null,
  runtimePairingUrl: null,
  webClientUrl: null,
  runtimePairingDeviceId: null,
  grantStatus: 'unknown',
  expiresAt: null,
  generatedViaRelay: false
}

export function clearGeneratedRuntimePairingLink(): void {
  runtimePairingLinkCache.runtimePairingUrl = null
  runtimePairingLinkCache.webClientUrl = null
  runtimePairingLinkCache.runtimePairingDeviceId = null
  runtimePairingLinkCache.grantStatus = 'unknown'
  runtimePairingLinkCache.generatedAddress = null
  runtimePairingLinkCache.expiresAt = null
  runtimePairingLinkCache.generatedViaRelay = false
}

function cacheGeneratedRuntimePairingLink(args: {
  address: string
  pairingUrl: string
  webClientUrl: string | null
  deviceId: string
  expiresAt: number | null
  viaRelay: boolean
}): void {
  runtimePairingLinkCache.runtimePairingUrl = args.pairingUrl
  runtimePairingLinkCache.webClientUrl = args.webClientUrl
  runtimePairingLinkCache.runtimePairingDeviceId = args.deviceId
  runtimePairingLinkCache.grantStatus = 'unknown'
  runtimePairingLinkCache.generatedAddress = args.address
  runtimePairingLinkCache.expiresAt = args.expiresAt
  runtimePairingLinkCache.generatedViaRelay = args.viaRelay
}

export function selectRuntimePairingIntent(
  intent: RuntimePairingIntent,
  networkInterfaces: { address: string }[],
  customAddress: string
): string {
  runtimePairingLinkCache.intent = intent
  const selectedAddress =
    intent === 'local'
      ? RUNTIME_PAIRING_LOOPBACK_ADDRESS
      : intent === 'another' || intent === 'relay'
        ? (networkInterfaces[0]?.address ?? '')
        : customAddress
  runtimePairingLinkCache.selectedAddress = selectedAddress
  return selectedAddress
}

export type RuntimePairingLinkResult =
  | {
      available: true
      pairingUrl: string
      webClientUrl: string | null
      deviceId: string
      expiresAt: number | null
      viaRelay: boolean
    }
  | { available: false; guidance?: string }

/** Mints a fresh link for the chosen intent and remembers it for the next settings visit. */
export async function requestRuntimePairingLink(
  intent: RuntimePairingIntent,
  address: string
): Promise<RuntimePairingLinkResult> {
  const result = await requestRuntimePairingLinkForIntent(intent, address)
  if (result.available) {
    cacheGeneratedRuntimePairingLink({ ...result, address })
  }
  return result
}

async function requestRuntimePairingLinkForIntent(
  intent: RuntimePairingIntent,
  address: string
): Promise<RuntimePairingLinkResult> {
  if (intent === 'relay') {
    // Main picks the direct address itself; a Relay link must work without one.
    const result = await window.api.mobile.getRuntimeRelayPairingUrl()
    return result.available
      ? {
          available: true,
          pairingUrl: result.pairingUrl,
          webClientUrl: null,
          deviceId: result.deviceId,
          expiresAt: result.inviteExpiresAt,
          viaRelay: true
        }
      : { available: false, guidance: result.guidance }
  }
  const result = await window.api.mobile.getRuntimePairingUrl({
    address,
    rotate: true,
    // Send declared reach with the address; loopback alone cannot distinguish local-only intent from a tunnel frontend.
    reach: runtimePairingReachForIntent(intent)
  })
  return result.available
    ? {
        available: true,
        pairingUrl: result.pairingUrl,
        webClientUrl: result.webClientUrl,
        deviceId: result.deviceId,
        expiresAt: result.expiresAt ?? null,
        viaRelay: false
      }
    : result
}
