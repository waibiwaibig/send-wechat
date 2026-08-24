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
