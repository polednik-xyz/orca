import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../../shared/remote-runtime/relay/mobile-relay-close-codes'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema
} from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import type {
  PairingOffer,
  PairingRelay
} from '../../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure
} from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import {
  EXCHANGE_PAIRING_TICKET_METHOD,
  PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY
} from '../../../../shared/remote-runtime/pairing/ticket-exchange-capability'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { deriveRelayHostId } from '../../../runtime/mobile-cloud-relay/director/relay-http-client'
import {
  openRuntimeRelayLink,
  type RuntimeRelayConnectUrl,
  type RuntimeRelayLinkClose
} from './runtime-relay-link'
import { isCellMove, relayCloseForClient } from './runtime-relay-link-upstream'
import { RuntimeRelayLinkRpc } from './runtime-relay-link-rpc'
import type { RuntimeRelayRoute } from './runtime-relay-route-store'

export type RuntimeRelayPairingResult =
  | {
      ok: true
      runtimeStatus: RuntimeStatus
      route: RuntimeRelayRoute
      /** The offer to save: the exchanged device token when the host supports ticket exchange. */
      offer: PairingOffer
    }
  | RemotePairingFailure

type InviteSession =
  | { kind: 'ready'; rpc: RuntimeRelayLinkRpc; close: () => void }
  | { kind: 'failed'; close: RuntimeRelayLinkClose }

// Why the text, not the bytes: the relay stores a digest of the serialized bearer it receives.
export function hashRuntimeRelayCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

/** Redeems a runtime Relay invite, verifies the server, and installs this client's own credential. */
export async function pairRuntimeEnvironmentThroughRelay(
  offer: PairingOffer,
  relay: PairingRelay,
  options: { connectUrl?: RuntimeRelayConnectUrl } = {}
): Promise<RuntimeRelayPairingResult> {
  let relayHostId: string
  try {
    relayHostId = deriveRelayHostId(
      NODE_PAIRED_E2EE_PRIMITIVES.publicKeyFromBase64(offer.publicKeyB64)
    )
  } catch {
    return failure('access-link-invalid', 'This access link contains invalid connection details.')
  }
  // Why: a tampered link could aim Relay at another host; E2EE would refuse it later, but fail clearly now.
  if (relayHostId !== relay.relayHostId) {
    return failure('access-link-invalid', 'This access link contains invalid Orca Relay details.')
  }
  const open = (baseUrl: string) => openInviteSession(baseUrl, offer, relay, options.connectUrl)
  let session = await open(relay.cellUrl)
  if (session.kind === 'failed' && isCellMove(session.close)) {
    const director = await open(relay.directorUrl)
    if (director.kind === 'ready') {
      director.close()
    } else if (
      director.close.kind === 'moved' &&
      director.close.assignmentEpoch > relay.assignmentEpoch
    ) {
      session = await open(director.close.cellUrl)
    } else {
      // Why: a cell answers an expired or spent invite with WRONG_CELL; only the director names it.
      session = director
    }
  }
  if (session.kind === 'failed') {
    return describeInviteFailure(session.close)
  }
  try {
    const installed = await installRelayCredential(session.rpc)
    if (!installed.ok) {
      return installed
    }
    return { ...installed, offer: await exchangeTicketOverRelay(session.rpc, offer, installed) }
  } catch (error) {
    return failure(
      'connection-interrupted',
      `The Orca Relay connection was interrupted during verification (${error instanceof Error ? error.message : String(error)}).`
    )
  } finally {
    session.close()
  }
}

async function installRelayCredential(
  rpc: RuntimeRelayLinkRpc
): Promise<
  { ok: true; runtimeStatus: RuntimeStatus; route: RuntimeRelayRoute } | RemotePairingFailure
> {
  const status = await rpc.request('status.get')
  if (!status.ok) {
    return failure('connection-interrupted', status.error.message)
  }
  const verified = verifyRemotePairingRuntimeStatus(status.result)
  if (!verified.ok) {
    return verified
  }
  const token = randomBytes(32).toString('base64url')
  const reqId = `install-${randomUUID()}`
  const installReply = await rpc.request('pairing.provisionRelay', {
    reqId,
    newResumeTokenHash: hashRuntimeRelayCredential(token)
  })
  if (!installReply.ok) {
    return failure(
      'connection-interrupted',
      `The Orca server did not issue an Orca Relay credential (${installReply.error.code}).`
    )
  }
  const installed = DeviceCredentialInstalledSchema.parse(installReply.result)
  const endpointsReply = await rpc.request('pairing.getEndpoints', { installReqId: reqId })
  const endpoints = endpointsReply.ok
    ? PairingGetEndpointsResultSchema.parse(endpointsReply.result)
    : null
  // Why: only the committed install record proves the cloud now accepts this token.
  if (
    endpoints?.installStatus?.state !== 'committed' ||
    endpoints.installStatus.result.reqId !== reqId ||
    !endpoints.relay
  ) {
    return failure('connection-interrupted', 'Orca Relay did not confirm the new credential.')
  }
  return {
    ok: true,
    runtimeStatus: verified.runtimeStatus,
    route: {
      endpoint: endpoints.relay,
      credential: { token, version: installed.currentVersion, expiresAt: installed.resumeExpiresAt }
    }
  }
}

// Why: like a direct pairing, save a token only this computer holds; the host keeps the device id,
// so the Relay credential just installed stays bound. Any failure keeps the link's token.
async function exchangeTicketOverRelay(
  rpc: RuntimeRelayLinkRpc,
  offer: PairingOffer,
  installed: { runtimeStatus: RuntimeStatus }
): Promise<PairingOffer> {
  if (!installed.runtimeStatus.capabilities?.includes(PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY)) {
    return offer
  }
  const deviceToken = randomBytes(24).toString('hex')
  try {
    const reply = await rpc.request(EXCHANGE_PAIRING_TICKET_METHOD, { deviceToken }, 10_000)
    return reply.ok ? { ...offer, deviceToken } : offer
  } catch {
    return offer
  }
}

function openInviteSession(
  baseUrl: string,
  offer: PairingOffer,
  relay: PairingRelay,
  connectUrl: RuntimeRelayConnectUrl | undefined
): Promise<InviteSession> {
  return new Promise((resolve) => {
    let ready = false
    const link = openRuntimeRelayLink({
      baseUrl,
      relayHostId: relay.relayHostId,
      hostPublicKeyB64: offer.publicKeyB64,
      deviceToken: offer.deviceToken,
      credential: { kind: 'invite', token: relay.inviteToken },
      connectUrl,
      handlers: {
        onAuthenticated: () => {
          ready = true
          resolve({ kind: 'ready', rpc, close: () => link.close() })
        },
        onText: (plaintext) => rpc.handleText(plaintext),
        onBinary: () => {},
        onClose: (close) => {
          rpc.rejectAll(new Error('Orca Relay link closed'))
          if (!ready) {
            resolve({ kind: 'failed', close })
          }
        }
      }
    })
    const rpc = new RuntimeRelayLinkRpc((plaintext) => link.sendText(plaintext), offer.deviceToken)
  })
}

function describeInviteFailure(close: RuntimeRelayLinkClose): RemotePairingFailure {
  if (close.kind === 'identity') {
    return failure(
      'host-identity-mismatch',
      'Orca Relay reached a server that does not match this access link.'
    )
  }
  if (
    close.kind === 'unauthorized' ||
    (close.kind === 'refused' && close.code === MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
  ) {
    return failure(
      'access-link-invalid',
      'This Orca Relay link has expired or was already used. Generate a new link on the Orca server.'
    )
  }
  if (close.kind === 'refused' && close.code === MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE) {
    return failure(
      'host-unreachable',
      'The Orca server is not connected to Orca Relay. Confirm Relay sharing is still active on that server.'
    )
  }
  return failure(
    'host-unreachable',
    `Cannot reach the Orca server through Orca Relay (${relayCloseForClient(close).reason}).`
  )
}

function failure(kind: RemotePairingFailure['kind'], message: string): RemotePairingFailure {
  return { ok: false, kind, message }
}
