import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteRuntimeRelayRoute,
  readRuntimeRelayRoute,
  writeRuntimeRelayRoute,
  type RuntimeRelayRoute
} from './runtime-relay-route-store'

const route: RuntimeRelayRoute = {
  endpoint: {
    v: 1,
    directorUrl: 'https://relay.example.com',
    cellUrl: 'https://cell.example.com',
    assignmentEpoch: 3,
    relayHostId: 'AbCdEf0123_-xyZ9',
    e2eeFraming: 2
  },
  credential: { token: 'B'.repeat(43), version: 1, expiresAt: 5_000 }
}
const binding = { environmentId: 'env-1', pairingRevision: 10, hostPublicKeyB64: 'host-key-a' }

describe('runtime Relay route store', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-routes-'))
  })
  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('hands a saved credential only to the pairing it was installed for', () => {
    writeRuntimeRelayRoute(userDataPath, binding, route)
    expect(readRuntimeRelayRoute(userDataPath, binding)).toEqual(route)
    // A re-pair under the same id, or a different host key, must not inherit the bearer.
    expect(readRuntimeRelayRoute(userDataPath, { ...binding, pairingRevision: 11 })).toBeNull()
    expect(
      readRuntimeRelayRoute(userDataPath, { ...binding, hostPublicKeyB64: 'host-key-b' })
    ).toBeNull()
  })

  it('removes the credential from disk when the server is removed', () => {
    writeRuntimeRelayRoute(userDataPath, binding, route)
    deleteRuntimeRelayRoute(userDataPath, binding.environmentId)
    expect(readRuntimeRelayRoute(userDataPath, binding)).toBeNull()
    const onDisk = readFileSync(join(userDataPath, 'orca-environment-relay-routes.json'), 'utf8')
    expect(onDisk).not.toContain(route.credential.token)
  })
})
