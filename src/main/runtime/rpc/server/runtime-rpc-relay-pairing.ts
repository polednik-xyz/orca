import {
  mobileRelayMintFailureFromUnknown,
  type MobileRelayMintFailure
} from '../../../../shared/remote-runtime/relay/mobile-relay-mint-failure'
import type { PairingRelay } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { PAIRING_OFFER_VERSION } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import type { RuntimePairingReach } from '../../../../shared/remote-runtime/pairing/runtime-pairing-reach'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import type { RuntimeDeviceGrant } from '../callers/rpc-method-permission'
import { RuntimeRpcPairing } from './runtime-rpc-pairing'
import type {
  MobileRelayPairingProvider,
  PairingOfferUnavailable,
  RuntimeRelayPairingOffer
} from './runtime-rpc-pairing-types'

export type PairingRelayMint =
  | { kind: 'minted'; relay: PairingRelay; deviceToken: string; publicKeyB64: string }
  | { kind: 'failed'; failure: MobileRelayMintFailure }
  | { kind: 'superseded' }

// How long a mint waits for an on-demand Relay install before reporting it missing.
const RELAY_PROVIDER_INSTALL_WAIT_MS = 15_000

const RELAY_BINDING_FAILURE: MobileRelayMintFailure = {
  code: 'relay_binding_failed',
  stage: 'binding_failed',
  message: 'Could not store Relay binding for the pairing device'
}

export class RuntimeRpcRelayPairing extends RuntimeRpcPairing {
  /** Runtime-scoped offer with a Relay invite; the direct offer survives a failed Relay mint. */
  async createRuntimeRelayPairingOffer(args: {
    address?: string | null
    name?: string
    rotate?: boolean
    reach?: RuntimePairingReach
    grants?: readonly RuntimeDeviceGrant[]
    offerTtlMs?: number
  }): Promise<PairingOfferUnavailable | RuntimeRelayPairingOffer> {
    this.discardExpiredRuntimeRelayOffers()
    const direct = this.createPairingOffer({ ...args, scope: 'runtime' })
    if (!direct.available) {
      return direct
    }
    const minted = await this.mintPairingRelay(direct.deviceId)
    if (minted.kind !== 'minted') {
      const failure: MobileRelayMintFailure =
        minted.kind === 'failed'
          ? minted.failure
          : {
              code: 'relay_request_superseded',
              stage: 'binding_failed',
              message: 'Relay pairing request superseded'
            }
      return { ...direct, relay: { available: false, failure } }
    }
    const hostDescriptor = this.hostDescriptor
    return {
      ...direct,
      relay: {
        available: true,
        pairingUrl: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: direct.endpoint,
          deviceToken: minted.deviceToken,
          publicKeyB64: minted.publicKeyB64,
          pairedDeviceId: direct.deviceId,
          scope: 'runtime',
          relay: minted.relay,
          ...(hostDescriptor ? { hostDescriptor } : {})
        }),
        inviteExpiresAt: minted.relay.inviteExpiresAt
      }
    }
  }

  /** Mints a Relay invite for a pending device and records its binding before the offer can leave. */
  protected async mintPairingRelay(
    deviceId: string,
    isCurrent: () => boolean = () => true
  ): Promise<PairingRelayMint> {
    if (!this.mobileRelayPairingProvider && this.mobileRelayPairingProviderInstaller) {
      // Bounded: the install waits for the persisted proxy, which has no time limit of its own.
      await withTimeout(
        this.mobileRelayPairingProviderInstaller(),
        RELAY_PROVIDER_INSTALL_WAIT_MS,
        undefined
      )
    }
    const relayProvider = this.mobileRelayPairingProvider
    if (!relayProvider) {
      return {
        kind: 'failed',
        failure: {
          code: 'relay_provider_unavailable',
          stage: 'provider_missing',
          message: 'Orca Relay is not available on this host'
        }
      }
    }
    const device = this.deviceRegistry?.getDevice(deviceId)
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!device?.token || !publicKeyB64) {
      return {
        kind: 'failed',
        failure: {
          code: 'e2ee_key_unavailable',
          stage: 'e2ee_missing',
          message: 'E2EE public key unavailable for Relay pairing'
        }
      }
    }
    let relayPairing: Awaited<ReturnType<MobileRelayPairingProvider['createPairingRelay']>>
    try {
      relayPairing = await relayProvider.createPairingRelay(device.deviceId)
    } catch (error) {
      // Provider errors may contain credentials/metadata; log validated codes only.
      const failure = mobileRelayMintFailureFromUnknown({
        stage: 'create_pairing_relay',
        error,
        fallbackCode: 'relay_mint_failed',
        fallbackMessage: 'Relay pairing invite request failed'
      })
      console.warn(`[runtime] Failed to create Relay pairing invite: ${failure.code}`)
      return { kind: 'failed', failure }
    }
    const currentDevice = this.deviceRegistry?.getDevice(device.deviceId)
    if (
      !isCurrent() ||
      relayProvider !== this.mobileRelayPairingProvider ||
      currentDevice?.token !== device.token
    ) {
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      return { kind: 'superseded' }
    }
    try {
      if (!this.setDeviceRelayBinding(device.deviceId, relayPairing.binding)) {
        this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
        return { kind: 'failed', failure: RELAY_BINDING_FAILURE }
      }
    } catch (error) {
      console.warn('[runtime] Failed to persist Relay pairing binding:', error)
      this.queueOrRetainRelayDeviceRevoke(device.deviceId, relayPairing.binding)
      return { kind: 'failed', failure: RELAY_BINDING_FAILURE }
    }
    return { kind: 'minted', relay: relayPairing.relay, deviceToken: device.token, publicKeyB64 }
  }

  /** The registry keeps expired Relay-bound offers until their cloud invite is revoked. */
  private discardExpiredRuntimeRelayOffers(): void {
    for (const expired of this.deviceRegistry?.listExpiredPairingOffers('runtime') ?? []) {
      if (!expired.relayBinding || !this.queueRelayDeviceRevoke(expired.relayBinding)) {
        continue
      }
      try {
        this.deviceRegistry?.removeDevice(expired.deviceId)
      } catch (error) {
        console.error('[runtime] Failed to drop an expired runtime pairing offer:', error)
      }
    }
  }
}
