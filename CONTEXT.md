# send-wechat context

## Purpose

`send-wechat` is an unofficial, standalone command-line tool that sends one
text message or one file to the Weixin user who explicitly bound the tool by
scanning its QR code. It is not a general Weixin client or an OpenClaw plugin.

## Domain vocabulary

- **binding**: the immutable relationship between the current operating-system
  user and the Weixin user who completed QR login.
- **binding user**: the only valid outbound recipient and the only inbound user
  whose messages may refresh the session.
- **daemon**: the per-user background process that alone owns credentials,
  Weixin network access, polling, delivery serialization, and session state.
- **Hub**: the only machine whose daemon owns a binding and connects directly
  to Weixin. One binding has exactly one Hub.
- **remote client**: an authorized machine that owns only a device credential
  and forwards CLI requests to the Hub; it never binds to Weixin.
- **Agent-first onboarding**: the public setup flow in which an Agent performs
  installation, diagnostics, and safe configuration, pausing only for a real
  account, identity, secret-entry, or device-choice action by the user.
- **personal relay**: a Worker and Durable Object deployed into the binding
  user's own Cloudflare account. It relays encrypted live frames and has no
  persistent message store.
- **pairing invitation**: a short-lived, single-use, authenticated value issued
  by the Hub that identifies the personal relay and authorizes one remote
  client.
- **session window**: the 24-hour interval beginning at the latest valid inbound
  message from the binding user.
- **connection confirmation**: one best-effort outbound acknowledgement when a
  valid inbound message first moves one binding activation from
  `awaiting_message` to `ready`. Ordinary session renewals do not trigger it.
- **renewal due**: the interval from hour 22 until hour 24 of a session window.
- **accepted**: the Weixin `sendmessage` endpoint returned HTTP success and a
  zero business result. It does not mean delivered or read.
- **result unknown**: a send request began but no authoritative business result
  was received. The daemon must not automatically replay it.
- **request ID**: a random identifier for one CLI invocation and its logs.
- **idempotency key**: a caller-provided or CLI-generated key used only for
  local duplicate suppression. It is not a Weixin delivery guarantee.
- **protocol pin**: Tencent `openclaw-weixin` tag `v2.4.6`, commit
  `cef0bfc390393f716903e16d50408118047f87e0`.

## Stable modules and seams

### CLI module

Its interface is the documented command set, human output, versioned JSON
output, and stable process exit codes. It may read message text, stdin, a user
file, and the local IPC capability. It never reads Weixin credentials.

### Runtime module

Its interface accepts one versioned local request and returns events followed
by exactly one final result. Behind that interface it owns binding policy,
session policy, idempotency, delivery serialization, state persistence, and
redacted logging.

Small session state is an atomically replaced JSON document. The seven-day
idempotency ledger is a separate fixed-schema SQLite database backed by the
Node.js 24 standard library; neither format is a public interface.

### iLink module

Its interface exposes QR login, polling, one logical outbound send, and
best-effort lifecycle notification. It hides Tencent HTTP payloads, headers,
media encryption, CDN upload, business-result validation, and protocol drift.

### Personal-relay module

Its interface provisions or removes the user-owned Cloudflare deployment,
issues and consumes pairing invitations, maintains the Hub's outbound relay
connection, and transports one versioned encrypted request to the Hub. It hides
Wrangler, workers.dev discovery, cryptographic framing, reconnect behavior, and
Cloudflare Durable Object routing. It never exposes Weixin credentials or a
general recipient interface.

### Platform modules

Credential-store and background-service interfaces are the platform seams.
The Hub uses native per-user credential facilities on macOS, Windows, and
GNU/Linux. A Linux remote client uses one strict owner-only device-credential
file so WSL and headless SSH sessions do not depend on Secret Service. That
file can contain only the remote client's own relay credential. There is no
process-environment credential source or role-crossing fallback.

## Trust model

- The current operating-system user on an authorized Hub or remote client is
  trusted. Any process running as that user may invoke the CLI without a second
  per-send confirmation.
- Other local users, remote hosts, inbound Weixin message content, user file
  paths, and all network responses are untrusted inputs.
- The Cloudflare control plane and personal relay may observe transport
  metadata but must receive only encrypted message/file frames. The user owns
  that Cloudflare account; the project operates no shared relay or directory.
- Administrator/root compromise, Tencent service compromise, and compromise of
  the current operating-system account are outside the product security claim.

## Product state

The repository is pre-release. Local automated tests and the Workers runtime
harness cover deterministic seams. A real user-owned Cloudflare deployment,
QR login, inbound activation, cross-device pairing, platform services, and real
Weixin text/file delivery remain distinct manual acceptance gates.
