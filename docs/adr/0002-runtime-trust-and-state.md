# ADR 0002: Runtime, trust, and state

Status: accepted

## Decision

Run exactly one Weixin-bound Hub for a binding. The Hub daemon communicates with
its local CLI over an owner-scoped Unix-domain socket on macOS/Linux or a
user-specific Windows named pipe. IPC uses length-prefixed, schema-versioned
frames and requires an owner-readable random local capability. CLI and daemon
versions must match exactly.

A paired remote client does not run a Weixin daemon and never receives Weixin
credentials. Its CLI sends an authenticated, end-to-end encrypted request to
the binding user's personal Cloudflare relay. The relay forwards the encrypted
frame to the Hub over the Hub's outbound WebSocket connection. It has no
persistent message store or outbox and reports `HUB_OFFLINE` when the Hub is not
connected.

The Hub daemon alone accesses Weixin credentials. It keeps the bot token,
current context token, relay connection secret, invitation secrets, and paired
device credentials in the native credential store. It persists only
owner-readable non-message state: the local role, binding identifiers,
validated Weixin and relay URLs, Cloudflare account ID and Worker name, polling
cursor, timestamps, authorized device identifiers, reminder state, idempotency
metadata, and the IPC capability. A remote client keeps only its own relay
credential and non-secret role/endpoint metadata. macOS and Windows clients use
their native credential store. A GNU/Linux client, including WSL and headless
SSH Linux, uses a strict owner-only credential file whose directory mode is
`0700` and file mode is `0600`. It rejects symlinks, non-owner files, broader
permissions, unknown schema, oversized input, and Hub-role records. GNU/Linux
Hub credentials remain in Secret Service. Credential storage is selected by
platform and role; there is no fallback reader between stores.

Small mutable state uses atomically replaced JSON. The seven-day idempotency
ledger remains on the Hub and uses Node.js 24's built-in SQLite module. There is
no migration or compatibility reader for a different state schema.

The binding and role are immutable. Explicit interactive Hub `reset` first
removes the user-owned relay deployment, then stops the daemon and deletes the
binding, credentials, state, logs, and temporary files. If cloud deletion
cannot be confirmed, local relay administration state is retained so the user
can retry. Remote-client `reset` deletes only that device's local credential and
state. Re-setup requires a new QR binding or a fresh pairing invitation.

## Consequences

Any process already running as the operating-system user of an authorized Hub
or remote client may send, which is the explicit trust interface. Other users
cannot obtain useful IPC or relay access merely by guessing an endpoint. The
CLI cannot accidentally print or pass Weixin credentials. The user, not this
project, owns the Cloudflare account, deployment, availability, and quota.
