# ADR 0005: Idempotency storage

Status: accepted

## Decision

Store the seven-day idempotency ledger in a dedicated owner-readable SQLite
database using the built-in `node:sqlite` module required by Node.js 24. Keep
binding, polling, and session state in the small atomically replaced JSON state
file. The ledger has a fixed schema marker, validates every row at the module
boundary, uses prepared statements, disables extension loading, and rejects an
unknown schema instead of migrating it.

Write the pending entry durably before beginning network I/O. A duplicate key
is a conflict at the database boundary as well as at the runtime boundary. A
failure to record the final metadata cannot turn an authoritative Weixin
acceptance into a reported failure; the durable pending entry remains a
conservative duplicate-suppression record.

## Consequences

The seven-day retention window remains practical under programmatic use without
placing unbounded rewrite cost on the session state file. SQLite is an internal
storage detail and does not create a public library or database interface.
