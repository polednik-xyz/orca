import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  addOrUpdateEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  remoteServerPairingStoreError,
  RuntimeEnvironmentStoreError
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import {
  parseHostAccessLink,
  type ParsedHostAccessLink
} from '../../../../shared/remote-runtime/pairing/remote-pairing-address'
import {
  verifyRemotePairingRuntimeStatus,
  type RemotePairingFailure,
  type VerifyAndAddRuntimeEnvironmentResult
} from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { exchangeRemotePairingTicket } from '../../../../shared/remote-runtime/pairing/remote-pairing-ticket-exchange'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import {
  getPreferredPairingOffer,
  isEphemeralVmRuntimeEnvironment,
  redactRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { findCollidingEnvironmentName } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-name-collision'
import { findEnvironmentWithHostKey } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-host-key-match'
import { encodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { pairRuntimeEnvironmentThroughRelay } from '../relay-route/runtime-relay-pairing'
import {
  saveRelayRouteForPairing,
  type RuntimeRelayRoute
} from '../relay-route/runtime-relay-route-store'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  remoteServerPairingFailureText,
  type RemoteServerPairingFailureCode
} from '../../../../shared/remote-runtime/pairing/remote-server-pairing-failure-copy'

type VerifyAndAddRuntimeEnvironmentArgs = {
  name: string
  pairingCode: string
  allowLoopback?: boolean
}

type VerifiedPairingCode = {
  ok: true
  link: ParsedHostAccessLink
  runtimeStatus: RuntimeStatus
  /** The code to save, holding a token only this computer has when the host could exchange it. */
  pairingCode: string
  relayRoute?: RuntimeRelayRoute
}

/** Proves a pairing link reaches a compatible host that accepts it, without saving anything. */
async function verifyPairingCode(
  pairingCode: string,
  allowLoopback: boolean | undefined
): Promise<VerifiedPairingCode | RemotePairingFailure> {
  const parsed = parseHostAccessLink(pairingCode)
  if (!parsed.ok) {
    return { ok: false, kind: 'access-link-invalid', message: parsed.message }
  }
  const { relay, ...offer } = parsed.value.pairing
  // Why before the loopback check: `orca serve --relay` links name loopback; Relay reaches the host anyway.
  if (relay) {
    const paired = await pairRuntimeEnvironmentThroughRelay(offer, relay)
    if (!paired.ok) {
      return paired
    }
    return {
      ok: true,
      link: parsed.value,
      runtimeStatus: paired.runtimeStatus,
      // The invite is spent; the saved code keeps only the direct pairing.
      pairingCode: encodePairingOffer(paired.offer),
      relayRoute: paired.route
    }
  }
  if (parsed.value.endpointKind === 'loopback' && !allowLoopback) {
    return {
      ok: false,
      kind: 'host-unreachable',
      message: 'This access link points back to this device.'
    }
  }
  try {
    const response = await sendRemoteRuntimeRequestOnSocket<RuntimeStatus>(
      pairedRuntimeConnectionFromOffer(parsed.value.pairing),
      'status.get',
      undefined,
      15_000,
      undefined,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      undefined,
      undefined
    )
    if (!response.ok) {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message: response.error.message
      }
    }
    const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
    if (!statusVerification.ok) {
      return statusVerification
    }
    // Save a token only this computer holds; the link stops working once it is used.
    const exchangedCode = await exchangeRemotePairingTicket({
      pairingCode,
      offer: parsed.value.pairing,
      hostCapabilities: statusVerification.runtimeStatus.capabilities
    })
    return {
      ok: true,
      link: parsed.value,
      runtimeStatus: statusVerification.runtimeStatus,
      pairingCode: exchangedCode
    }
  } catch (error) {
    return classifyPairingVerificationError(error, parsed.value.displayEndpoint)
  }
}

export async function verifyAndAddRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: VerifyAndAddRuntimeEnvironmentArgs
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const blocked = await relayAddBlocked(userDataPath, args)
  if (blocked) {
    return blocked
  }
  const verified = await verifyPairingCode(args.pairingCode, args.allowLoopback)
  if (!verified.ok) {
    return verified
  }
  const { link, runtimeStatus, pairingCode } = verified
  const usesSshTunnel =
    !verified.relayRoute && link.endpointKind === 'loopback' && args.allowLoopback === true
  let outcome: Awaited<ReturnType<typeof addOrUpdateEnvironmentFromPairingCode>>
  try {
    outcome = await addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      ...args,
      pairingCode,
      // Only a verified key match permits updating an existing server identity.
      runtimeId: runtimeStatus.runtimeId,
      ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
    })
  } catch (error) {
    return pairingSaveFailure(error, 'hostSaveFailed')
  }
  saveRelayRouteForPairing(userDataPath, outcome.environment, verified.relayRoute)
  return {
    ok: true,
    environment: redactRuntimeEnvironment(outcome.environment),
    runtimeStatus,
    ...(outcome.updatedExisting ? { updatedExisting: true as const } : {})
  }
}

/** Replace pairing only after verifying the saved host key; invalid or foreign links leave it untouched. */
export async function verifyAndRepairRuntimeEnvironmentFromPairingCode(
  userDataPath: string,
  args: { selector: string; pairingCode: string }
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const existing = await resolveEnvironment(userDataPath, args.selector)
  if (isEphemeralVmRuntimeEnvironment(existing)) {
    return pairingSaveFailure(null, 'repairCloudWorkspace')
  }
  // Why before verifying: redeeming a Relay invite spends it and installs a credential on that host.
  const relayLink = parseHostAccessLink(args.pairingCode)
  if (
    relayLink.ok &&
    relayLink.value.pairing.relay &&
    relayLink.value.pairing.publicKeyB64 !== getPreferredPairingOffer(existing).publicKeyB64
  ) {
    return differentServerResult()
  }
  // SSH tunnel pairings legitimately use loopback links.
  const verified = await verifyPairingCode(
    args.pairingCode,
    existing.connectionDependency === 'ssh-tunnel'
  )
  if (!verified.ok) {
    return verified
  }
  // Host key persists across restarts; runtimeId does not.
  if (verified.link.pairing.publicKeyB64 !== getPreferredPairingOffer(existing).publicKeyB64) {
    return differentServerResult()
  }
  let environment: Awaited<ReturnType<typeof updateEnvironmentFromPairingCode>>
  try {
    environment = await updateEnvironmentFromPairingCode(userDataPath, existing.id, {
      pairingCode: verified.pairingCode,
      // The verified same host may have restarted with a new runtimeId.
      runtimeId: verified.runtimeStatus.runtimeId
    })
  } catch (error) {
    return pairingSaveFailure(error, 'repairSaveFailed')
  }
  saveRelayRouteForPairing(userDataPath, environment, verified.relayRoute)
  return {
    ok: true,
    environment: redactRuntimeEnvironment(environment),
    runtimeStatus: verified.runtimeStatus
  }
}

/** A name clash after redeeming a Relay invite would strand the credential it installed. */
async function relayAddBlocked(
  userDataPath: string,
  args: VerifyAndAddRuntimeEnvironmentArgs
): Promise<RemotePairingFailure | null> {
  const link = parseHostAccessLink(args.pairingCode)
  if (!link.ok || !link.value.pairing.relay) {
    return null
  }
  const environments = await listEnvironments(userDataPath)
  if (findEnvironmentWithHostKey(environments, link.value.pairing.publicKeyB64)) {
    return null
  }
  const clash = findCollidingEnvironmentName(environments, args.name)
  return clash
    ? pairingSaveFailure(
        remoteServerPairingStoreError('nameTaken', { name: clash.name }),
        'hostSaveFailed'
      )
    : null
}

function differentServerResult(): RemotePairingFailure {
  return {
    ok: false,
    kind: 'different-server',
    message: 'This pairing link is for a different server.'
  }
}

/** A store refusal keeps its own message and code; anything else gets the generic save failure. */
function pairingSaveFailure(
  error: unknown,
  fallback: RemoteServerPairingFailureCode
): RemotePairingFailure {
  if (error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument') {
    return {
      ok: false,
      kind: 'environment-save-failed',
      message: error.message,
      ...error.pairingFailure
    }
  }
  return {
    ok: false,
    kind: 'environment-save-failed',
    message: remoteServerPairingFailureText(fallback),
    errorCode: fallback
  }
}

function classifyPairingVerificationError(error: unknown, endpoint: string): RemotePairingFailure {
  if (error instanceof RemoteRuntimeClientError) {
    if (error.code === 'invalid_argument') {
      return invalidAccessLinkResult()
    }
    if (error.code === 'unauthorized' || error.pairingStage === 'access-grant') {
      return {
        ok: false,
        kind: 'access-link-invalid',
        message: 'This access link is no longer valid. Generate a new link on the other host.'
      }
    }
    if (error.pairingStage === 'host-identity') {
      return {
        ok: false,
        kind: 'host-identity-mismatch',
        message: `Orca reached ${endpoint}, but that host does not match this access link.`
      }
    }
    if (error.pairingStage === 'runtime') {
      return {
        ok: false,
        kind: 'connection-interrupted',
        message: `The connection to ${endpoint} was interrupted during verification.`
      }
    }
    if (error.pairingStage === 'connect') {
      return unreachableHostResult(endpoint)
    }
  }
  if (error instanceof Error) {
    return error.message.startsWith('Invalid public key')
      ? invalidAccessLinkResult()
      : { ok: false, kind: 'connection-interrupted', message: error.message }
  }
  return unreachableHostResult(endpoint)
}

function invalidAccessLinkResult(): RemotePairingFailure {
  return {
    ok: false,
    kind: 'access-link-invalid',
    message: 'This access link contains invalid connection details.'
  }
}

function unreachableHostResult(endpoint: string): RemotePairingFailure {
  return {
    ok: false,
    kind: 'host-unreachable',
    message: `Cannot reach Orca at ${endpoint}. Confirm the other host is running and reachable.`
  }
}
