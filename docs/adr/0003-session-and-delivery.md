# ADR 0003: Session and delivery semantics

Status: accepted

## Decision

Only a fresh inbound message from the binding user establishes or renews the
session window. Inbound content is ignored and never stored. Session states are
`not_logged_in`, `awaiting_message`, `ready`, `renewal_due`, `blocked`, and
`auth_stale`.

When the first valid inbound message moves a binding activation from
`awaiting_message` to `ready`, the daemon attempts one connection confirmation
through the normal serialized send, audit, and idempotency path. It persists
the new session and polling cursor before the attempt. Rejected or ambiguous
confirmation does not roll back readiness and is never automatically retried.
Ordinary inbound session renewal does not send another confirmation.

The daemon attempts one renewal reminder after hour 22 and before hour 24, only
while the delivery queue is idle. It records the attempt before network I/O and
never retries an ambiguous reminder. At hour 24 it fails closed and blocks sends
until a new inbound message arrives.

Each request carries one text payload or one file payload. Sends are serialized,
paced, and kept only in memory. There is no persistent outbox. The daemon never
automatically retries `sendmessage` after beginning the request. A non-zero
business result is rejected; an ambiguous network result is `result_unknown`.
CDN byte upload may retry non-4xx failures at most three times before
`sendmessage` begins.

The daemon records a seven-day metadata-only idempotency ledger before network
I/O. Matching key and payload return the existing result without resending;
pending or unknown entries stay unknown; a reused key with a different payload
is a conflict. This is local duplicate suppression, not server idempotency.

## Consequences

The tool prefers duplicate avoidance and truthful uncertainty over optimistic
delivery claims. A crash cannot cause an old request to be replayed later.
