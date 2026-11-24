import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'

export type RuntimeRelayBridgeAuthentication = 'authenticated' | 'unauthorized' | 'failed'

/**
 * The host leg behind the bridge, already past transport setup and E2EE key agreement.
 * A direct leg has not yet proven the host key: only `authenticate` does, by the host answering under it.
 */
export type RuntimeRelayBridgeUpstream = {
  route: 'direct' | 'relay'
  authenticate(
    clientCapabilities: readonly RuntimeCapability[]
  ): Promise<RuntimeRelayBridgeAuthentication>
  sendText(plaintext: string): boolean
  sendBinary(bytes: Uint8Array): boolean
  ping(): void
  close(): void
}

export type RuntimeRelayBridgeUpstreamEvents = {
  onText(plaintext: string): void
  onBinary(bytes: Uint8Array): void
  onPong(): void
  onClose(code: number, reason: string): void
}

export type RuntimeRelayBridgeUpstreamOpen =
  | { ok: true; upstream: RuntimeRelayBridgeUpstream }
  | { ok: false; unauthorized: boolean; message: string }
