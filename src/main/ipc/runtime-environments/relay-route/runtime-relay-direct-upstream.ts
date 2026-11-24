import WebSocket from 'ws'
import { createRemoteRuntimeClientHandshake } from '../../../../shared/remote-runtime/remote-runtime-client-framing'
import { remoteRuntimeConnectOptions } from '../../../../shared/remote-runtime/remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import {
  acceptSealedReady,
  openSealedFrame,
  openSealedText,
  readSealedFrame
} from '../../../../shared/remote-runtime/remote-runtime-sealed-frame'
import type {
  RuntimeRelayBridgeAuthentication,
  RuntimeRelayBridgeUpstream,
  RuntimeRelayBridgeUpstreamEvents,
  RuntimeRelayBridgeUpstreamOpen
} from './runtime-relay-upstream-contract'

// Why short: a direct miss is followed by a Relay attempt inside the same client connect.
const DIRECT_ROUTE_CONNECT_TIMEOUT_MS = 4_000

/** The paired endpoint, spoken to with the same framing policy the client stack uses. */
export function openDirectBridgeUpstream(
  target: { endpoint: string; hostPublicKeyB64: string; deviceToken: string },
  events: RuntimeRelayBridgeUpstreamEvents
): Promise<RuntimeRelayBridgeUpstreamOpen> {
  return new Promise((resolve) => {
    const handshake = createRemoteRuntimeClientHandshake(target.hostPublicKeyB64)
    let phase: 'connecting' | 'awaiting_ready' | 'keyed' | 'ready' | 'closed' = 'connecting'
    let authWaiter: ((outcome: RuntimeRelayBridgeAuthentication) => void) | null = null
    const ws = new WebSocket(
      target.endpoint,
      remoteRuntimeConnectOptions(
        { maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES },
        DIRECT_ROUTE_CONNECT_TIMEOUT_MS
      )
    )
    const keyTimer = setTimeout(
      () => shutdown({ code: 1006, reason: 'Direct route did not complete E2EE setup' }),
      DIRECT_ROUTE_CONNECT_TIMEOUT_MS
    )

    // Why one exit: before key agreement a failure settles the open; after it, the bridge must hear the close.
    function shutdown(outcome: { code: number; reason: string } | null): void {
      if (phase === 'closed') {
        return
      }
      const before = phase
      phase = 'closed'
      clearTimeout(keyTimer)
      ws.removeAllListeners('message')
      ws.on('error', () => {})
      ws.terminate()
      const settleAuth = authWaiter
      settleAuth?.('failed')
      if (before === 'connecting' || before === 'awaiting_ready') {
        resolve({
          ok: false,
          unauthorized: false,
          message: outcome?.reason ?? 'Direct route closed'
        })
      } else if (outcome && !settleAuth) {
        // Why not during auth: a host that is not the paired one closes here, and the bridge
        // must be free to retry through Relay instead of hearing a close.
        events.onClose(outcome.code, outcome.reason)
      }
    }

    const upstream: RuntimeRelayBridgeUpstream = {
      route: 'direct',
      authenticate: (clientCapabilities) =>
        new Promise((settle) => {
          if (phase !== 'keyed') {
            settle('failed')
            return
          }
          // Why: a host that is not the paired one may never answer; fall back before the client times out.
          const authTimer = setTimeout(
            () => shutdown({ code: 1006, reason: 'Direct route did not authenticate' }),
            DIRECT_ROUTE_CONNECT_TIMEOUT_MS
          )
          authWaiter = (outcome) => {
            authWaiter = null
            clearTimeout(authTimer)
            if (outcome === 'authenticated') {
              phase = 'ready'
            }
            settle(outcome)
          }
          handshake
            .sealAuth(
              { kind: 'token', deviceToken: target.deviceToken },
              { clientCapabilities: [...clientCapabilities] }
            )
            .then((auth) => {
              if (phase === 'keyed') {
                ws.send(auth)
              }
            })
            .catch(() => shutdown({ code: 1002, reason: 'Direct route refused the E2EE framing' }))
        }),
      sendText: (plaintext) => send(handshake.channel.sealText(plaintext)),
      sendBinary: (bytes) => send(handshake.channel.sealBinary(bytes)),
      ping: () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping()
        }
      },
      close: () => shutdown(null)
    }

    function send(frame: string | Uint8Array): boolean {
      if (phase !== 'ready' || ws.readyState !== WebSocket.OPEN) {
        return false
      }
      ws.send(frame, { binary: typeof frame !== 'string' })
      return true
    }

    // Why only a sealed reply counts: the paired host alone can answer under its key.
    function classifyAuthFrame(data: WebSocket.RawData, isBinary: boolean) {
      const opened = openSealedText(handshake, readSealedFrame(data, isBinary))
      if (opened.kind === 'failed') {
        return 'failed'
      }
      const reply = handshake.classifyAuthReply(opened.text)
      if (reply.kind === 'authenticated') {
        return 'authenticated'
      }
      return reply.kind === 'rejected' && reply.errorCode === 'unauthorized'
        ? 'unauthorized'
        : 'failed'
    }

    ws.once('open', () => {
      phase = 'awaiting_ready'
      try {
        ws.send(handshake.helloText())
      } catch {
        shutdown({ code: 1002, reason: 'Direct route refused the E2EE framing' })
      }
    })
    ws.on('message', (data, isBinary) => {
      if (phase === 'awaiting_ready') {
        if (acceptSealedReady(handshake, readSealedFrame(data, isBinary)) !== 'accepted') {
          shutdown({ code: 1002, reason: 'Direct route returned an invalid E2EE handshake' })
          return
        }
        phase = 'keyed'
        clearTimeout(keyTimer)
        resolve({ ok: true, upstream })
        return
      }
      if (phase === 'keyed' && authWaiter) {
        authWaiter(classifyAuthFrame(data, isBinary))
        return
      }
      if (phase !== 'ready') {
        return
      }
      const opened = openSealedFrame(handshake, readSealedFrame(data, isBinary))
      if (opened.kind === 'text') {
        events.onText(opened.text)
      } else if (opened.kind === 'binary') {
        events.onBinary(opened.bytes)
      }
    })
    ws.on('pong', () => events.onPong())
    ws.on('error', (error) => shutdown({ code: 1006, reason: error.message }))
    ws.on('close', (code, reason) => shutdown({ code, reason: reason.toString() }))
  })
}
