# Pairing remote Orca servers through Orca Relay

A port of stablyai/orca#25492 onto the current main structure. It lets a desktop pair with an Orca server that it can't reach directly.

## What it does

**Host side**

- Settings → Remote Orca Servers → Share this host → **Any network** creates a single-use Relay invite link.
  - The link expires after 10 minutes.
  - The panel asks the user to sign in for Relay until they are signed in.
  - Team policy (`relay.use`) can block it.
- `orca serve --relay` prints the direct URL plus a Relay URL (JSON: `pairing.relay.url`), or a stable failure reason:
  - `relay_sign_in_required`
  - `relay_not_entitled`
  - `relay_cloud_unconfigured`
  - otherwise, the error code from creating the link.
- If creating the Relay link fails, the grant minted for it is revoked.
- Minting a newer link revokes the unused invite of an older grant.
- `pairing.getEndpoints` and `pairing.provisionRelay` answer only runtime grants that were minted with a Relay invite (`relayBinding`). Direct-only grants get `relay: null` or `relay_disabled_for_device`.

**Client side**

- Add Remote Orca Server accepts a `scope:'runtime'` offer carrying Relay metadata, even when the direct endpoint is loopback, and labels it "Orca Relay".
- Pairing installs a fresh resume credential over Relay (`provisionRelay` plus a committed `installStatus`), so the stored credential is never the invite itself. Then it runs the ticket exchange over Relay.
- The installed Relay route is stored in `orca-environment-relay-routes.json` under userData.
  - It is bound to the environment id, the pairing revision and the host public key. A re-pair or a key change never inherits the old bearer.
  - It is deleted when the server is removed.
- Routing: one `RuntimeRelayBridge` per environment (`ws://relay.orca.invalid/<envId>`, registered as a socket connector).
  - It tries direct first, then falls back to Relay.
  - A direct attempt counts only once the host has proven the paired key. Any other direct failure falls back to Relay, because the address may now reach someone else.
  - After a direct miss, the bridge stays on Relay for 5 minutes, then tries direct again.
  - Relay requires E2EE framing v2.
- When the host or the director rejects the credential, the client sees `unauthorized` and marks the access revoked.
- Status labels: `Connected · Orca Relay`, `Connected · Direct · LAN`, `Connected · Direct · Tailscale`, `Connected · Direct`.

## Deviations from the PR and why

- **The route sidecar** is bound to pairing revision and host key, and deleted on removal. Why: the PR keyed it by environment id only, so a re-pair could reuse a stale bearer.
- **The bridge speaks legacy E2EE toward the client stack** and Relay E2EE v2 on the host leg.
  - Why: the in-process hop never leaves the process, and the client stack keeps one transport.
  - A v2 hello is refused with 4001, so the stack redials with legacy framing.
- **The socket connector is applied** in the request-socket, request-websocket and subscription transports, not in one call site. Why: main split those transports.
- **The dial and evidence call sites** are substituted with the bridge endpoint.
- **Bridge close ordering fix.** `RuntimeRelayBridgeSession.closeClient` closes the client before closing the upstream.
  - Why: closing a Relay upstream reports its own close (1000) back synchronously. That used to overwrite the 4001 refusal, which broke the legacy redial and the `unauthorized` signal.
  - The ported integration test caught it.
- **Reused main's building blocks** instead of the PR's copies:
  - the name-clash normalization;
  - the `expiresAt` UI for the link expiry;
  - `OrcaSignInButton` and `OrcaSignInWaitNotice`;
  - the `relay.use` team-policy block;
  - shared serve readiness.
- **Repair accepts Relay links too.**
- **Max-lines splits.** The pairing intent options and `readRelayAccountFailure` moved into their own modules.
- **Tests inject an in-memory `OrchestrationDb`.**
  - Why: revoking a grant opens `orchestration.db` lazily. On Windows, that file locks the vitest userData folder (EBUSY on cleanup).
  - This also happens on main and is not caused by this port.

## Tests ported

All of these guard security or protocol invariants:

- **Host side:** the invite is bound to its grant, revoke on link failure, revoking a grant queues its cloud revoke, a newer link revokes the older invite, and runtime-grant gating in `DesktopRelayService`. The 10-minute TTL is a constant and is not tested.
- **Client side:**
  - the route store binding;
  - the host-id/key mismatch refused before dialing;
  - an integration test covering: pairing over Relay, revoke by the host, revoke by the director, direct-first, falling back from a foreign direct server, the 5-minute Relay preference, revoke over direct, and a spent invite.

Dropped as not security-relevant: the cell-move, renewal and dropped-client integration cases, and the UI tests.

## Known limitations

- If writing the route fails after the environment is saved, the invite is already spent and the user must pair again.
- An unreadable routes file is overwritten on the next write.
- These stay direct-only: the web client, a browser-hosted client, the WSL sites and the ephemeral-VM probe.
- After a ticket exchange over Relay, the old token stays valid until the first bridge sign-in.
- The route label (Relay or direct) updates only when status is published.
