import type { MobilePairingConnectionMode } from '../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../../shared/remote-runtime/relay/mobile-relay-mint-failure'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from './pairing/network/network-exposure-guidance'
import { createOwnerPairingOffer } from './pairing/pairing-offer-requests'
import type { PairingOffersRpcContext } from '../core'
import { RuntimeRpcRelayPairing } from './runtime-rpc-relay-pairing'
import {
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type MobilePairingOffer,
  type PairingOfferUnavailable
} from './runtime-rpc-pairing-types'

export class RuntimeRpcMobilePairing extends RuntimeRpcRelayPairing {
  protected override ownerPairingOffers(): PairingOffersRpcContext {
    return {
      create: async (params, createdByDeviceId, createdByClientInstanceId) => {
        const offer = await createOwnerPairingOffer(this, params, undefined, createdByDeviceId)
        if (offer.available && createdByClientInstanceId) {
          this.deviceRegistry?.setOriginClientInstance(offer.deviceId, createdByClientInstanceId)
        }
        return offer
      }
    }
  }

  async createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    name?: string
    rotate?: boolean
    offerTtlMs?: number
    createdByDeviceId?: string
  }): Promise<MobilePairingOffer> {
    // Network pairing opts into LAN exposure: widen before advertising QR endpoints; failed widening stays unavailable on loopback (STA-2370).
    try {
      await this.ensureNetworkExposure()
    } catch (error) {
      console.error(
        '[runtime] Network exposure failed while creating a mobile pairing offer:',
        error
      )
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
    if (args.connectionMode === 'local-only') {
      this.mobilePairingOfferGeneration += 1
      return this.createMobilePairingOfferSerial(args, this.mobilePairingOfferGeneration)
    }
    const address = args.address ?? null
    const rotate = args.rotate === true
    const inFlight = this.mobileRelayPairingOfferInFlight
    if (
      inFlight?.generation === this.mobilePairingOfferGeneration &&
      inFlight.address === address &&
      inFlight.createdByDeviceId === args.createdByDeviceId &&
      (inFlight.rotate || !rotate)
    ) {
      return inFlight.request
    }
    // Why: every request that is not coalesced above supersedes the older one, rotating or not.
    const generation = ++this.mobilePairingOfferGeneration
    const request = this.mobileRelayPairingOfferQueue.then(() =>
      generation === this.mobilePairingOfferGeneration
        ? this.createMobilePairingOfferSerial(args, generation)
        : this.relayPairingRequestSuperseded()
    )
    this.mobileRelayPairingOfferQueue = request.then(
      () => undefined,
      () => undefined
    )
    this.mobileRelayPairingOfferInFlight = {
      generation,
      address,
      rotate,
      createdByDeviceId: args.createdByDeviceId,
      request
    }
    void request.then(
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      },
      () => {
        if (this.mobileRelayPairingOfferInFlight?.request === request) {
          this.mobileRelayPairingOfferInFlight = null
        }
      }
    )
    return request
  }

  protected async createMobilePairingOfferSerial(
    args: {
      address?: string | null
      connectionMode?: MobilePairingConnectionMode
      name?: string
      rotate?: boolean
      offerTtlMs?: number
      createdByDeviceId?: string
    },
    generation: number
  ): Promise<MobilePairingOffer> {
    // Renderer input is untrusted; only explicit local-only may suppress Relay provisioning.
    const connectionMode = args.connectionMode === 'local-only' ? 'local-only' : 'automatic'
    // Expired offers leave through discard so their Relay invites are revoked too.
    for (const expired of this.deviceRegistry?.listExpiredPairingOffers('mobile') ?? []) {
      this.discardPendingMobilePairingDevice(expired.deviceId)
    }
    const pending = this.deviceRegistry?.getPendingDevice(
      'mobile',
      args.offerTtlMs,
      [],
      args.createdByDeviceId
    )
    // Rotate when connection policy changes so old QR credentials retain no new-policy authority.
    const switchingPendingMode =
      pending != null &&
      this.deviceRegistry?.getMobilePairingConnectionMode(pending.deviceId) !== connectionMode
    if (args.rotate || switchingPendingMode) {
      // Durably enqueue cloud revocation for every offer rotation drops, or old invites outlive the QR.
      for (const offer of this.deviceRegistry?.listPendingDevices('mobile') ?? []) {
        if (offer.relayBinding && !this.queueRelayDeviceRevoke(offer.relayBinding)) {
          return pairingUnavailable(
            'device_registry_unavailable',
            'Could not persist Relay cleanup before rotating the pairing code.'
          )
        }
      }
    }
    const direct = this.createPairingOffer({
      ...args,
      rotate: args.rotate || switchingPendingMode,
      scope: 'mobile'
    })
    if (!direct.available) {
      return direct
    }
    const createdNewPendingDevice = pending?.deviceId !== direct.deviceId
    let connectionModeStored = false
    try {
      connectionModeStored =
        this.deviceRegistry?.setMobilePairingConnectionMode(direct.deviceId, connectionMode) ??
        false
    } catch (error) {
      console.error('[runtime] Failed to persist the pairing connection mode:', error)
    }
    // Persist credential mode or refuse; a QR must never pair under an unstored default policy.
    if (!connectionModeStored) {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    // Why: explicit LAN path never needs Relay; mint the direct-only offer as selected.
    if (connectionMode === 'local-only') {
      return { ...direct, connectionMode: 'local-only' }
    }
    // Anywhere cannot silently become LAN-only; remove unused pending credentials and let UI offer LAN explicitly.
    const refuseAutomaticWithoutRelay = (
      relayFailure: MobileRelayMintFailure
    ): PairingOfferUnavailable => {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return {
        available: false,
        reason: 'relay_mint_failed',
        guidance:
          'Orca Relay could not create a pairing invite. Use LAN (Tailscale or same Wi‑Fi) or retry Relay.',
        relayFailure
      }
    }
    const minted = await this.mintPairingRelay(
      direct.deviceId,
      () =>
        generation === this.mobilePairingOfferGeneration &&
        this.deviceRegistry?.getMobilePairingConnectionMode(direct.deviceId) === 'automatic'
    )
    if (minted.kind === 'superseded') {
      if (createdNewPendingDevice) {
        this.discardPendingMobilePairingDevice(direct.deviceId)
      }
      return this.relayPairingRequestSuperseded()
    }
    if (minted.kind === 'failed') {
      return refuseAutomaticWithoutRelay(minted.failure)
    }
    return {
      ...direct,
      connectionMode: 'automatic',
      pairingUrl: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: direct.endpoint,
        deviceToken: minted.deviceToken,
        publicKeyB64: minted.publicKeyB64,
        pairedDeviceId: direct.deviceId,
        scope: 'mobile',
        relay: minted.relay
      })
    }
  }

  protected relayPairingRequestSuperseded(): PairingOfferUnavailable {
    return {
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'The Relay pairing request was replaced by a newer connection choice.',
      relayFailure: {
        code: 'relay_request_superseded',
        stage: 'binding_failed',
        message: 'Relay pairing request superseded'
      }
    }
  }

  /** Drop a never-scanned mobile pending credential after a failed Anywhere mint. */
  protected discardPendingMobilePairingDevice(deviceId: string): void {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (!device || device.scope !== 'mobile' || device.lastSeenAt !== 0) {
      return
    }
    if (device.relayBinding) {
      if (!this.queueRelayDeviceRevoke(device.relayBinding)) {
        return
      }
    }
    try {
      this.deviceRegistry?.removeDevice(deviceId)
    } catch (error) {
      console.error('[runtime] Failed to drop an unused mobile pairing credential:', error)
    }
  }

  /** If durable revoke enqueue fails, retain the device binding as the only remaining cleanup reference to the minted invite. */
}
