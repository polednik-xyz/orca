import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { classifyRemotePairingHostname } from '../../../../shared/remote-runtime/pairing/remote-pairing-address'
import { RuntimeRelayBridge } from './runtime-relay-bridge'
import {
  readRuntimeRelayRoute,
  runtimeRelayRouteBinding,
  updateRuntimeRelayRoute
} from './runtime-relay-route-store'

const bridges = new Map<string, { key: string; bridge: RuntimeRelayBridge }>()

/**
 * The connection a client transport should dial. Servers paired through Orca Relay get their
 * in-process bridge, which tries the paired endpoint first and falls back to Relay; others are
 * unchanged. Identity checks must keep using `getPreferredPairedRuntimeConnection`, which names
 * the real server key.
 */
export function getRuntimeEnvironmentDialConnection(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): PairedRuntimeConnection {
  const connection = getPreferredPairedRuntimeConnection(environment)
  const binding = runtimeRelayRouteBinding({
    ...environment,
    hostPublicKeyB64: connection.hostPublicKeyB64
  })
  if (!readRuntimeRelayRoute(userDataPath, binding)) {
    disposeRuntimeEnvironmentRelayBridge(environment.id)
    return connection
  }
  const { deviceToken } = connection.credential
  const key = [
    userDataPath,
    binding.pairingRevision,
    connection.endpoint,
    deviceToken,
    connection.hostPublicKeyB64,
    environment.connectionDependency ?? ''
  ].join('\0')
  let cached = bridges.get(environment.id)
  if (!cached || cached.key !== key) {
    cached?.bridge.dispose()
    cached = {
      key,
      bridge: new RuntimeRelayBridge({
        environmentId: environment.id,
        deviceToken,
        hostPublicKeyB64: connection.hostPublicKeyB64,
        directEndpoint: isDirectEndpointUsable(environment, connection.endpoint)
          ? connection.endpoint
          : null,
        readRoute: () => readRuntimeRelayRoute(userDataPath, binding),
        writeRoute: (update) => updateRuntimeRelayRoute(userDataPath, binding, update)
      })
    }
    bridges.set(environment.id, cached)
  }
  return {
    ...connection,
    endpoint: cached.bridge.endpoint,
    hostPublicKeyB64: cached.bridge.publicKeyB64
  }
}

/** Annotates a status snapshot with the route its connection took; Relay-less servers are direct. */
export function withRuntimeEnvironmentRoute(
  snapshot: RuntimeHostStatusSnapshot
): RuntimeHostStatusSnapshot {
  const bridge = bridges.get(snapshot.environmentId)?.bridge
  const route = bridge ? bridge.activeRoute : 'direct'
  return route ? { ...snapshot, route } : snapshot
}

export function disposeRuntimeEnvironmentRelayBridge(environmentId: string): void {
  const cached = bridges.get(environmentId)
  bridges.delete(environmentId)
  cached?.bridge.dispose()
}

// Why: `orca serve --relay` without --pairing-address advertises loopback, which only an SSH tunnel reaches.
function isDirectEndpointUsable(environment: KnownRuntimeEnvironment, endpoint: string): boolean {
  try {
    return (
      environment.connectionDependency === 'ssh-tunnel' ||
      classifyRemotePairingHostname(new URL(endpoint).hostname) !== 'loopback'
    )
  } catch {
    return false
  }
}
