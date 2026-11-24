import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../rpc/server/pairing/device-registry'
import { DesktopRelayService } from './desktop-relay-service'

describe('relay-disabled device grants', () => {
  const userDataPaths: string[] = []

  afterEach(() => {
    for (const path of userDataPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function serviceFor(registry: DeviceRegistry): DesktopRelayService {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal path reads only runtimeRpc, defined below
    const service = Object.create(DesktopRelayService.prototype) as DesktopRelayService
    Object.defineProperty(service, 'runtimeRpc', {
      value: { getDeviceRegistry: () => registry }
    })
    return service
  }

  function createRegistry(): DeviceRegistry {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-disabled-'))
    userDataPaths.push(userDataPath)
    return new DeviceRegistry(userDataPath)
  }

  async function expectRelayRefused(service: DesktopRelayService, deviceId: string) {
    const directContext = {
      deviceId,
      connectionId: 'e2ee-connection-1',
      transport: { transport: 'direct' as const }
    }
    await expect(service.getEndpoints(directContext, {})).resolves.toEqual({ v: 1, relay: null })
    await expect(
      service.provisionRelay(directContext, {
        reqId: 'install-1',
        newResumeTokenHash: 'A'.repeat(43)
      })
    ).rejects.toThrow('relay_disabled_for_device')
  }

  it('refuses endpoint discovery and provisioning for a local-only mobile grant', async () => {
    const registry = createRegistry()
    const device = registry.addDevice('Phone', 'mobile')
    registry.setMobilePairingConnectionMode(device.deviceId, 'local-only')

    await expectRelayRefused(serviceFor(registry), device.deviceId)
  })

  it('refuses endpoint discovery and provisioning for a runtime grant minted without a Relay invite', async () => {
    const registry = createRegistry()
    const device = registry.addDevice('Laptop', 'runtime')

    await expectRelayRefused(serviceFor(registry), device.deviceId)
  })
})
