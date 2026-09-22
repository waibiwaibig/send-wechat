# Feishu repair validation — 2026-09-22

This record describes commit `dce16af`, before the subsequent first-message onboarding
change. Its live delivery result does not certify that later onboarding flow.

The first-use report covered an unsupported event flag, dropped text with an empty
attachment array, private-chat delivery targeting, an unclassified Markdown send,
and insufficient health diagnostics.

## Delivered behavior

- Event consumption retains the bot identity and profile without `--format`.
  Structured startup failures retain safe CLI codes.
- Valid text with `attachments: []` enters the inbox. Empty messages remain invalid.
  Appends report accepted, rejected, duplicate, expired, overflow and inactive counts.
- A DM binds both the owner and the challenge event's private chat. Sending and
  receiving use that verified chat. Missing DM chat IDs require explicit rebinding;
  group isolation and owner restrictions remain enforced.
- Files and images upload through the typed CLI API before message submission.
  Upload and submit outcomes retain distinct safe causes. Unknown submissions remain
  terminal across ledger reopening; no automatic replay or channel change occurs.
- Status distinguishes loaded configuration from observed listener, inbox and send
  activity. Diagnostics exclude message bodies, binding codes, credentials and paths.
- Subprocess tests wait for the mock spawn event with a real-time watchdog. This
  removes the WSL race caused by exhausting 100 event-loop iterations before mkdir
  completed, without weakening the subprocess assertions.

## Verification

| Environment         | Full check                                             | Build  | Additional evidence                                               |
| ------------------- | ------------------------------------------------------ | ------ | ----------------------------------------------------------------- |
| macOS, Node 24.19.0 | 502 unit tests passed, 1 skipped; 4 Relay tests passed | Passed | Typecheck, lint, formatting and coverage thresholds passed        |
| WSL, Node 24.20.0   | 511 unit tests passed, 1 skipped; 4 Relay tests passed | Passed | Existing independent iLink changes preserved and SHA-256 verified |

Both environments ran `npm run check` and `npm run build`. The WSL Relay test runner
printed workerd request-stream exceptions while reporting all four tests passed and
exiting successfully; Relay implementation was outside this repair.

The WSL Hub was rebuilt and restarted. Its real Feishu subscription reported
`listener: listening` with no listener error. One authorized send of
`send-message-feishu-issues-2026-09-22.md` returned `accepted`; the user explicitly
confirmed receipt in the bound bot DM. No second file send was performed.

The real-module conversation regression covers configuration save/load, owner/chat
filtering, SQLite ingestion, a stub model response, message submission and persistent
deduplication. A fresh human-originated text-to-secretary round trip remains a separate
live acceptance step. The secretary service was running and responsive when checked.

## Limits and provenance

The original failed file request discarded its detailed cause. This repair does not
claim to reconstruct its exact failure stage. The new file path has passed actual
delivery and now retains stage-specific failure evidence for future diagnosis.
Image delivery, a fresh app-creation scan, group delivery and additional devices were
not exercised against a real account in this session.

Pinned CLI implementation evidence is linked by file and line in
[ADR 0010, References](adr/0010-feishu-official-cli.md#references). Offline binary
help/schema tests verify the exact installed v1.0.96 command contracts.
