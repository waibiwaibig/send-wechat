# ADR 0008: Bounded retries for atomic file replacement

Status: accepted

## Context

Windows CI reproduced `EPERM` when gateway startup replaced `status.json` while
the status reader was polling it. Repeated startup tests exposed the rename
error that a readiness timeout had previously hidden. The same temporary-file
replacement pattern serves Hub state, installation metadata, client credentials,
service configuration and QR image refreshes.

## Decision

Use one platform operation for renaming a completed temporary file into place.
On Windows, `p-retry` handles `EPERM`, `EACCES` and `EBUSY` with up to ten retries,
an initial 10 ms delay, a 100 ms maximum delay and a 1000 ms retry budget. This
allows short-lived readers to release the file while bounding additional wait
time. Other errors and other platforms retain the native rename behavior.

Each attempt uses the same temporary file and destination. The existing
destination remains intact until replacement succeeds. Callers retain schema,
ownership and symlink validation, exclusive temporary-file creation, file and
directory syncing, and cleanup after failure. A missing installation directory
causes the operation to fail without recreating it.

## Validation

Deterministic tests inject transient and persistent rename errors around real
temporary files. They verify that the old contents survive failed attempts,
successful replacement consumes the temporary file, failures remain bounded,
and unrelated errors propagate immediately. Windows CI also repeatedly starts
the gateway while reading its status, then removes the installation directory
and verifies that the gateway fails closed.

Reference: [p-retry options](https://github.com/sindresorhus/p-retry/tree/v8.0.1).
