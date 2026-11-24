import WebSocket from 'ws'
import { createPairedE2EEClientHandshake } from '../../../../shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import {
  RelayMovedSchema,
  RelayPhoneHelloSchema
} from '../../../../shared/remote-runtime/relay/mobile-relay-phone-protocol'
import { remoteRuntimeConnectOptions } from '../../../../shared/remote-runtime/remote-runtime-connect-bound'
import {
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES,
  serializeRemoteRuntimePayload
} from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import {
  openSealedFrame,
  readSealedFrame
} from '../../../../shared/remote-runtime/remote-runtime-sealed-frame'
import { parseRemoteRuntimeJsonText } from '../../../../shared/remote-runtime/requests/remote-runtime-request-frames'

const RELAY_LINK_HANDSHAKE_TIMEOUT_MS = 15_000

export type RuntimeRelayLinkCredential = { kind: 'invite' | 'resume'; token: string }

export type RuntimeRelayLinkClose =
  /** The cell or director refused the outer credential with a 44xx/45xx relay code. */
  | { kind: 'refused'; code: number }
  /** The director answered an invite with the cell that now owns this host. */
  | { kind: 'moved'; cellUrl: string; assignmentEpoch: number }
  /** The host rejected the device token over E2EE: the grant was revoked. */
  | { kind: 'unauthorized' }
  /** The peer behind Relay does not hold the server key the pairing link pinned. */
  | { kind: 'identity' }
  | { kind: 'closed'; code: number; reason: string }
  | { kind: 'protocol'; message: string }

export type RuntimeRelayLinkHandlers = {
  onAuthenticated: () => void
  onText: (plaintext: string) => void
  onBinary: (bytes: Uint8Array) => void
  onPong?: () => void
  onClose: (close: RuntimeRelayLinkClose) => void
}

export type RuntimeRelayLink = {
  sendText(plaintext: string): boolean
  sendBinary(bytes: Uint8Array): boolean
  ping(): void
  close(): void
}

export type RuntimeRelayConnectUrl = (baseUrl: string, relayHostId: string) => string

/** The relay's client connect socket for `relayHostId`, on a cell or on the director. */
export function relayConnectWebSocketUrl(baseUrl: string, relayHostId: string): string {
  const url = new URL(baseUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relayHostId)}`
  return url.toString()
}

type LinkState = 'connecting' | 'awaiting_hello' | 'awaiting_ready' | 'awaiting_auth' | 'ready'

/** One Relay splice to the host: outer credential, then E2EE v2 pinned to `hostPublicKeyB64`. */
export function openRuntimeRelayLink(args: {
  baseUrl: string
  relayHostId: string
  hostPublicKeyB64: string
  deviceToken: string
  credential: RuntimeRelayLinkCredential
  handlers: RuntimeRelayLinkHandlers
  // Why: tests dial a local plain-ws relay; production always forces wss.
  connectUrl?: RuntimeRelayConnectUrl
}): RuntimeRelayLink {
  // Why v2 only: Relay carries traffic through a third party, so legacy framing is never offered.
  const handshake = createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64: args.hostPublicKeyB64,
    framing: 'v2',
    transport: 'relay',
    relayHostId: args.relayHostId,
    parseJson: parseRemoteRuntimeJsonText,
    serializeJson: serializeRemoteRuntimePayload
  })
  const url = (args.connectUrl ?? relayConnectWebSocketUrl)(args.baseUrl, args.relayHostId)
  let state: LinkState = 'connecting'
  let finished = false
  const ws = new WebSocket(
    url,
    remoteRuntimeConnectOptions({
      perMessageDeflate: false,
      maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES
    })
  )
  const handshakeTimer = setTimeout(
    () => finish({ kind: 'protocol', message: 'Orca Relay handshake timed out' }),
    RELAY_LINK_HANDSHAKE_TIMEOUT_MS
  )

  function finish(close: RuntimeRelayLinkClose): void {
    if (finished) {
      return
    }
    finished = true
    clearTimeout(handshakeTimer)
    ws.removeAllListeners('message')
    // Why: a late transport error after we chose the outcome must not become an unhandled event.
    ws.on('error', () => {})
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate()
    }
    args.handlers.onClose(close)
  }

  ws.once('open', () => {
    state = 'awaiting_hello'
    ws.send(
      JSON.stringify({
        type: 'relay-auth',
        v: 1,
        mode: 'connect',
        credential: args.credential.token
      })
    )
  })
  ws.on('message', (data, isBinary) => {
    handleMessage(data, isBinary).catch((error: unknown) =>
      finish({ kind: 'protocol', message: error instanceof Error ? error.message : String(error) })
    )
  })
  ws.on('pong', () => args.handlers.onPong?.())
  ws.on('error', (error) => finish({ kind: 'closed', code: 1006, reason: error.message }))
  ws.on('close', (code, reason) => {
    finish(
      code >= 4400 && code < 4600 && state !== 'ready'
        ? { kind: 'refused', code }
        : { kind: 'closed', code, reason: reason.toString() }
    )
  })

  async function handleMessage(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (state === 'ready') {
      // Why openSealedFrame: a v2 host may compress frames; the bridge forwards what they carry.
      const opened = openSealedFrame(handshake, readSealedFrame(data, isBinary))
      if (opened.kind === 'failed') {
        throw new Error('Orca Relay delivered an unreadable frame')
      }
      if (opened.kind === 'text') {
        args.handlers.onText(opened.text)
      } else {
        args.handlers.onBinary(opened.bytes)
      }
      return
    }
    if (isBinary) {
      throw new Error('Orca Relay sent a binary frame before E2EE was ready')
    }
    const text = data.toString()
    if (state === 'awaiting_hello') {
      acceptOuterHello(parseRemoteRuntimeJsonText(text))
    } else if (state === 'awaiting_ready') {
      if (handshake.acceptReadyText(text) !== 'accepted') {
        finish({ kind: 'identity' })
        return
      }
      state = 'awaiting_auth'
      const auth = await handshake.sealAuth({ kind: 'token', deviceToken: args.deviceToken })
      if (!finished) {
        ws.send(auth)
      }
    } else if (state === 'awaiting_auth') {
      acceptAuthentication(handshake.channel.openText(text))
    }
  }

  function acceptOuterHello(value: unknown): void {
    const moved = RelayMovedSchema.safeParse(value)
    if (moved.success) {
      finish({
        kind: 'moved',
        cellUrl: moved.data.cellUrl,
        assignmentEpoch: moved.data.assignmentEpoch
      })
      return
    }
    const hello = RelayPhoneHelloSchema.parse(value)
    if (!hello.ok) {
      finish({ kind: 'refused', code: hello.code })
      return
    }
    if (hello.credentialKind !== args.credential.kind) {
      throw new Error('Orca Relay resolved the credential as an unexpected kind')
    }
    state = 'awaiting_ready'
    ws.send(handshake.helloText())
  }

  function acceptAuthentication(plaintext: string | null): void {
    const reply = plaintext === null ? null : handshake.classifyAuthReply(plaintext)
    if (reply?.kind === 'rejected' && reply.errorCode === 'unauthorized') {
      finish({ kind: 'unauthorized' })
      return
    }
    if (reply?.kind !== 'authenticated') {
      throw new Error('Orca server rejected the Relay E2EE handshake')
    }
    state = 'ready'
    clearTimeout(handshakeTimer)
    args.handlers.onAuthenticated()
  }

  function send(frame: string | Uint8Array): boolean {
    if (finished || state !== 'ready' || ws.readyState !== WebSocket.OPEN) {
      return false
    }
    ws.send(frame, { binary: typeof frame !== 'string' })
    return true
  }

  return {
    sendText: (plaintext) => send(handshake.channel.sealText(plaintext)),
    sendBinary: (bytes) => send(handshake.channel.sealBinary(bytes)),
    ping: () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    },
    close: () => finish({ kind: 'closed', code: 1000, reason: 'client closed' })
  }
}
