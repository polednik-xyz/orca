import WebSocket from 'ws'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'
import {
  createPairedE2EELegacyChannel,
  type PairedE2EEChannel
} from '../../../../shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import type { PairedE2EEKeyPair } from '../../../../shared/remote-runtime/e2ee/paired-e2ee-primitives'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { readSealedFrame } from '../../../../shared/remote-runtime/remote-runtime-sealed-frame'
import { parseRemoteRuntimeJsonText } from '../../../../shared/remote-runtime/requests/remote-runtime-request-frames'
import { parseRuntimeClientCapabilities } from '../../../runtime/rpc/callers/runtime-client-capabilities'
import type {
  RuntimeRelayBridgeUpstream,
  RuntimeRelayBridgeUpstreamEvents,
  RuntimeRelayBridgeUpstreamOpen
} from './runtime-relay-upstream-contract'

type BridgeSessionState = 'awaiting_hello' | 'awaiting_auth' | 'authenticating' | 'ready' | 'closed'

// Why 4001: the client stack redials an unproven host with legacy framing after this refusal.
const UNSUPPORTED_HELLO_CLOSE_CODE = 4001

export type RuntimeRelayBridgeSessionHooks = {
  /** Opens the Relay leg after the direct endpoint answered but did not prove the paired key. */
  fallBackToRelay(events: RuntimeRelayBridgeUpstreamEvents): Promise<RuntimeRelayBridgeUpstreamOpen>
  onAuthenticated(route: RuntimeRelayBridgeUpstream['route']): void
}

/**
 * Answers the client stack's legacy handshake in-process, then relays plaintext to the host leg.
 * Why in-process: the stack keeps one transport implementation; the host leg (direct or Relay)
 * carries its own end-to-end session pinned to the paired server key.
 */
export class RuntimeRelayBridgeSession {
  private ws: WebSocket | null = null
  private upstream: RuntimeRelayBridgeUpstream | null = null
  private channel: PairedE2EEChannel | null = null
  private state: BridgeSessionState = 'awaiting_hello'
  private pendingClose: { code: number; reason: string } | null = null

  readonly upstreamEvents: RuntimeRelayBridgeUpstreamEvents = {
    // Why drop before ready: the client has sent no request yet, so only keepalives can arrive.
    onText: (plaintext) => {
      if (this.state === 'ready' && this.channel) {
        this.sendToClient(this.channel.sealText(plaintext))
      }
    },
    onBinary: (bytes) => {
      if (this.state === 'ready' && this.channel) {
        this.sendToClient(this.channel.sealBinary(bytes))
      }
    },
    onPong: () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong()
      }
    },
    onClose: (code, reason) => this.closeClient(code, reason)
  }

  constructor(
    private readonly bridgeKeys: PairedE2EEKeyPair,
    private readonly deviceToken: string,
    private readonly hooks: RuntimeRelayBridgeSessionHooks
  ) {}

  attach(ws: WebSocket, opened: RuntimeRelayBridgeUpstreamOpen): void {
    this.ws = ws
    this.upstream = opened.ok ? opened.upstream : null
    ws.on('message', (data, isBinary) => this.handleClientFrame(data, isBinary))
    // Why: client liveness pings must measure the host leg, not this in-process hop.
    ws.on('ping', () => this.upstream?.ping())
    ws.on('error', () => {})
    ws.on('close', () => {
      this.state = 'closed'
      this.upstream?.close()
    })
    if (this.pendingClose) {
      this.closeClient(this.pendingClose.code, this.pendingClose.reason)
    }
  }

  private handleClientFrame(data: WebSocket.RawData, isBinary: boolean): void {
    const frame = readSealedFrame(data, isBinary)
    if (this.state === 'awaiting_hello') {
      this.acceptHello(typeof frame === 'string' ? frame : null)
    } else if (this.state === 'awaiting_auth') {
      this.acceptAuth(
        typeof frame === 'string' && this.channel ? this.channel.openText(frame) : null
      )
    } else if (this.state === 'ready' && this.channel && this.upstream) {
      if (typeof frame !== 'string') {
        const bytes = this.channel.openBinary(frame)
        if (bytes) {
          this.upstream.sendBinary(bytes)
        }
        return
      }
      const plaintext = this.channel.openText(frame)
      if (plaintext !== null) {
        this.upstream.sendText(plaintext)
      }
    }
  }

  private acceptHello(raw: string | null): void {
    let clientPublicKey: Uint8Array
    try {
      const hello: unknown = raw === null ? null : parseRemoteRuntimeJsonText(raw)
      // Why legacy only: this hop never leaves the process; a v2 hello lacks publicKeyB64 and is refused.
      if (
        typeof hello !== 'object' ||
        hello === null ||
        !('type' in hello) ||
        hello.type !== 'e2ee_hello' ||
        !('publicKeyB64' in hello) ||
        typeof hello.publicKeyB64 !== 'string'
      ) {
        throw new Error('invalid hello')
      }
      clientPublicKey = NODE_PAIRED_E2EE_PRIMITIVES.publicKeyFromBase64(hello.publicKeyB64)
    } catch {
      this.closeClient(UNSUPPORTED_HELLO_CLOSE_CODE, 'Invalid e2ee_hello')
      return
    }
    this.channel = createPairedE2EELegacyChannel(
      NODE_PAIRED_E2EE_PRIMITIVES,
      NODE_PAIRED_E2EE_PRIMITIVES.deriveSharedKey(this.bridgeKeys.secretKey, clientPublicKey)
    )
    this.state = 'awaiting_auth'
    this.sendToClient(JSON.stringify({ type: 'e2ee_ready' }))
  }

  private acceptAuth(plaintext: string | null): void {
    let auth: unknown = null
    try {
      auth = plaintext === null ? null : parseRemoteRuntimeJsonText(plaintext)
    } catch {
      auth = null
    }
    if (
      typeof auth !== 'object' ||
      auth === null ||
      !('type' in auth) ||
      auth.type !== 'e2ee_auth' ||
      !('deviceToken' in auth) ||
      auth.deviceToken !== this.deviceToken ||
      !this.upstream
    ) {
      this.rejectClient()
      return
    }
    this.state = 'authenticating'
    const clientCapabilities = parseRuntimeClientCapabilities(
      'clientCapabilities' in auth ? auth.clientCapabilities : undefined
    )
    void this.authenticateUpstream(this.upstream, clientCapabilities)
  }

  private async authenticateUpstream(
    upstream: RuntimeRelayBridgeUpstream,
    clientCapabilities: readonly RuntimeCapability[]
  ): Promise<void> {
    let outcome = await upstream.authenticate(clientCapabilities)
    // Why: only the paired host can answer 'unauthorized' under our key; any other direct
    // failure means the address now reaches someone else, so Relay may still reach the server.
    if (outcome === 'failed' && upstream.route === 'direct' && this.state === 'authenticating') {
      upstream.close()
      this.upstream = null
      const relay = await this.hooks.fallBackToRelay(this.upstreamEvents)
      if (this.state !== 'authenticating') {
        if (relay.ok) {
          relay.upstream.close()
        }
        return
      }
      if (!relay.ok) {
        if (relay.unauthorized) {
          this.rejectClient()
        } else {
          this.closeClient(1011, relay.message)
        }
        return
      }
      this.upstream = relay.upstream
      outcome = await relay.upstream.authenticate(clientCapabilities)
    }
    if (this.state !== 'authenticating' || !this.upstream) {
      return
    }
    if (outcome === 'unauthorized') {
      this.rejectClient()
    } else if (outcome === 'failed') {
      this.closeClient(1011, 'The Orca server did not accept the session')
    } else {
      this.state = 'ready'
      this.hooks.onAuthenticated(this.upstream.route)
      this.sendEncryptedControl({ type: 'e2ee_authenticated' })
    }
  }

  // Why the same frame the host sends: the client marks the access revoked only on this shape.
  private rejectClient(): void {
    this.sendEncryptedControl({ type: 'e2ee_error', error: { code: 'unauthorized' } })
    this.closeClient(4001, 'Unauthorized')
  }

  private sendEncryptedControl(message: unknown): void {
    if (this.channel) {
      this.sendToClient(this.channel.sealText(JSON.stringify(message)))
    }
  }

  private sendToClient(frame: string | Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame, { binary: typeof frame !== 'string' })
    }
  }

  private closeClient(code: number, reason: string): void {
    if (!this.ws) {
      this.pendingClose ??= { code, reason }
      return
    }
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason.slice(0, 120))
    }
    // Why after: closing the upstream reports its own close back here; the client must get this code.
    const upstream = this.upstream
    this.upstream = null
    upstream?.close()
  }
}
