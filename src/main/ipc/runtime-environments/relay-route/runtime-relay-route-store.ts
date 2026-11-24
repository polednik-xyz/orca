import { join } from 'node:path'
import { z } from 'zod'
import { MobileRelayEndpointSchema } from '../../../../shared/remote-runtime/relay/mobile-relay-credential-contract'
import {
  invalidateEnvironmentStoreObservation,
  readEnvironmentRegistryFile
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store-observation'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { writeSecureJsonFileWithinLimit } from '../../../../shared/secure-storage/bounded-secure-json-file'

// Why a sidecar: shipped builds strip unknown fields from orca-environments.json on rewrite.
const RELAY_ROUTES_FILE = 'orca-environment-relay-routes.json'
const MAX_RELAY_ROUTES_FILE_BYTES = 256 * 1024

const RuntimeRelayRouteSchema = z.object({
  endpoint: MobileRelayEndpointSchema,
  credential: z.object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    version: z.number().int().positive(),
    expiresAt: z.number().int().nonnegative()
  })
})

export type RuntimeRelayRoute = z.infer<typeof RuntimeRelayRouteSchema>

/** The pairing a route was installed for; a re-pair under the same id must not inherit it. */
export type RuntimeRelayRouteBinding = {
  environmentId: string
  pairingRevision: number
  hostPublicKeyB64: string
}

const StoredRouteSchema = RuntimeRelayRouteSchema.extend({
  pairingRevision: z.number().finite(),
  hostPublicKeyB64: z.string().min(1)
})

const EnvelopeSchema = z.object({
  version: z.literal(1),
  routes: z.record(z.string(), z.unknown())
})

export function runtimeRelayRouteBinding(environment: {
  id: string
  createdAt: number
  pairingRevision?: number
  hostPublicKeyB64: string
}): RuntimeRelayRouteBinding {
  return {
    environmentId: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    hostPublicKeyB64: environment.hostPublicKeyB64
  }
}

function routesPath(userDataPath: string): string {
  return join(userDataPath, RELAY_ROUTES_FILE)
}

// Why: every dial consults the route; only this process writes the file, so a memo stays exact.
const routesByPath = new Map<string, Record<string, unknown>>()

function readRawRoutes(userDataPath: string): Record<string, unknown> {
  const path = routesPath(userDataPath)
  const cached = routesByPath.get(path)
  if (cached) {
    return cached
  }
  let routes: Record<string, unknown> = {}
  try {
    const read = readEnvironmentRegistryFile(path, MAX_RELAY_ROUTES_FILE_BYTES)
    routes = read ? EnvelopeSchema.parse(JSON.parse(read.buffer.toString('utf8'))).routes : {}
  } catch (error) {
    // Why: an unreadable file only costs the Relay fallback; the direct route still works.
    console.warn('[runtime-relay-route] Ignoring unreadable Relay routes:', error)
  }
  routesByPath.set(path, routes)
  return routes
}

function writeRawRoutes(userDataPath: string, routes: Record<string, unknown>): void {
  const path = routesPath(userDataPath)
  invalidateEnvironmentStoreObservation(path)
  // Why secure + durable: the resume token is a bearer credential for this server.
  routesByPath.delete(path)
  writeSecureJsonFileWithinLimit(path, { version: 1, routes }, MAX_RELAY_ROUTES_FILE_BYTES, {
    durable: true
  })
  routesByPath.set(path, routes)
}

export function readRuntimeRelayRoute(
  userDataPath: string,
  binding: RuntimeRelayRouteBinding
): RuntimeRelayRoute | null {
  const parsed = StoredRouteSchema.safeParse(readRawRoutes(userDataPath)[binding.environmentId])
  if (
    !parsed.success ||
    parsed.data.pairingRevision !== binding.pairingRevision ||
    parsed.data.hostPublicKeyB64 !== binding.hostPublicKeyB64
  ) {
    return null
  }
  return { endpoint: parsed.data.endpoint, credential: parsed.data.credential }
}

export function writeRuntimeRelayRoute(
  userDataPath: string,
  binding: RuntimeRelayRouteBinding,
  route: RuntimeRelayRoute
): void {
  const stored = StoredRouteSchema.parse({
    ...route,
    pairingRevision: binding.pairingRevision,
    hostPublicKeyB64: binding.hostPublicKeyB64
  })
  writeRawRoutes(userDataPath, { ...readRawRoutes(userDataPath), [binding.environmentId]: stored })
}

/** Applies `update` only while the stored route still belongs to `binding`. */
export function updateRuntimeRelayRoute(
  userDataPath: string,
  binding: RuntimeRelayRouteBinding,
  update: (route: RuntimeRelayRoute) => RuntimeRelayRoute
): void {
  const current = readRuntimeRelayRoute(userDataPath, binding)
  if (current) {
    writeRuntimeRelayRoute(userDataPath, binding, update(current))
  }
}

export function deleteRuntimeRelayRoute(userDataPath: string, environmentId: string): void {
  const routes = readRawRoutes(userDataPath)
  if (!(environmentId in routes)) {
    return
  }
  const { [environmentId]: _removed, ...rest } = routes
  writeRawRoutes(userDataPath, rest)
}

/** Binds the Relay route to the pairing just saved; a direct re-pair drops any older route. */
export function saveRelayRouteForPairing(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  route: RuntimeRelayRoute | undefined
): void {
  try {
    if (!route) {
      deleteRuntimeRelayRoute(userDataPath, environment.id)
      return
    }
    const { hostPublicKeyB64 } = getPreferredPairedRuntimeConnection(environment)
    writeRuntimeRelayRoute(
      userDataPath,
      runtimeRelayRouteBinding({ ...environment, hostPublicKeyB64 }),
      route
    )
  } catch (error) {
    // Why not fail: the server is saved and reachable directly; only the Relay fallback is lost.
    console.warn('[runtime-environments] Could not save the Orca Relay route:', error)
  }
}
