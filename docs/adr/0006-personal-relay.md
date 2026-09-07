# ADR 0006: User-owned personal relay

Status: accepted

## Decision

Provision one Worker plus one SQLite-backed Durable Object in each binding
user's own Cloudflare Free account. Use a pinned official Wrangler release with
OAuth device authorization and operating-system keyring storage. Deploy to the
account's `workers.dev` subdomain so setup requires no custom domain, router
change, public IP, copied API token, or project-operated infrastructure.

The Worker routes to one Durable Object representing the personal relay. The
Hub authenticates one outbound WebSocket connection. A remote client submits a
versioned encrypted request; the Durable Object forwards it to the connected
Hub and returns the encrypted final response. Payloads exist only in live
request and WebSocket memory. The relay does not persist payloads, files,
device credentials, or an outbox. A missing Hub connection returns
`HUB_OFFLINE` immediately.

Remote files are split into bounded encrypted frames. Only the Hub stages the
plaintext file in its owner-only temporary directory; it verifies the declared
length and whole-file SHA-256 before delivery and removes the staging file on
completion or abort. The Durable Object never assembles or stores a file.

The Hub issues a high-entropy, short-lived, single-use pairing invitation. It
contains the relay endpoint and enough authenticated key material for exactly
one remote client to establish its own credential. The Hub, not the relay,
stores device authorization and consumes invitations. Expired, forged, and
replayed invitations fail closed.

A fresh Hub setup does not create an invitation. To add a device, the user or
Agent explicitly runs `setup --pair-stdout`. A direct SSH pipeline can feed
`setup --pair-stdin`; for manual transfer the user copies the code into the
interactive `setup --pair` prompt. The user's private chat is an acceptable
transfer channel. Codes never belong in command arguments, diagnostic logs, or
reports. No extra browser endpoint, public pairing directory, or short-code
lookup service is needed.

Client setup saves the actual device credential and installation metadata and
reads both back before sending the pairing request to the Hub. The Hub therefore
only accepts a request whose local persistence has already succeeded. No local
credential save occurs after acceptance. Failures roll back local records; an
unsuccessful rollback reports a distinct cleanup error and directs the user to
local client recovery. Retries of the same in-memory encrypted request return
the Hub's original acknowledgement. Pairing uses three network attempts with a
ten-second timeout each and brief progress messages (about 31 seconds maximum
network wait including backoff). A process crash or lost final response can
still require diagnosis and re-pairing; this is not a distributed transaction.

All application frames are encrypted and authenticated between the remote
client and Hub. Relay routing metadata, ciphertext size, timing, and source IP
remain visible to Cloudflare. HTTPS alone is not described as end-to-end
encryption.

## Consequences

The product behaves like user-owned standalone software while still crossing
NAT and firewalls. The user must complete one Cloudflare authorization on the
Hub. Local non-secret administration state records the exact account ID and
Worker name so reset deletes only that deployment. The user remains responsible
for that account's availability, quotas, and removal. A new machine cannot
discover a personal relay without a pairing invitation because the project
intentionally operates no global directory.

Cloudflare Quick Tunnels are not a production adapter: their endpoint changes
after restart and Cloudflare documents them as development-only with no uptime
guarantee. There is no automatic fallback to a LAN listener, public port,
shared relay, or plaintext transport.

## SSH storage decision (2026-09-07)

macOS clients now use the existing Linux owner-only file store. Keychain access
from SSH can need a desktop security context; avoiding that dependency removes
the reported prompt/hang path. Native Keychain timeouts and an additional
pairing acknowledgement protocol would add moving parts without improving this
client path. File permissions match the current-OS-user trust model; at-rest
protection depends on that account and the OS/disk. Windows clients and Hub
credential storage retain their native store.

This uses an established CLI pattern: [OpenSSH](https://man.openbsd.org/ssh)
requires private keys to be inaccessible to other users, and
[GitHub CLI](https://cli.github.com/manual/gh_auth_login) supports file-based
credential storage. This project selects one store per platform/role, with no
runtime storage fallback or legacy migration.
