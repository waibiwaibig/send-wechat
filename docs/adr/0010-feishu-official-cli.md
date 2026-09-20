# ADR 0010: Feishu through the official CLI

Status: Accepted, 2026-09-20.

## Decision

Use the pinned `@larksuite/cli` package as the sole Feishu transport. Package installation
provides its native executable; the Hub resolves that executable from its dependency,
not the shell PATH. The Node SDK and manual app-secret/recipient JSON setup are removed.
This updates ADR 0009's Feishu implementation while retaining its channel semantics.

The official CLI owns app creation and credentials in an isolated send-message profile.
The sender owns fixed recipient configuration, owner authorization, queues and persistent
idempotency. Commands run as the application bot with argument arrays and structured
responses. No personal OAuth login is required. Setup displays the official registration
link, waits for event readiness, and binds a fresh user message carrying a one-use
challenge. A group binding additionally checks the bot mention and fixes both the owner
and group. Rerunning setup reuses credentials and completed bindings; explicit rebind
replaces a target only after successful verification.

Both sending and optional secretary receiving use CLI subprocesses. Incoming events use
the CLI's documented flattened schema; media resource keys come from message API data.
Only bound-owner messages reach the secretary. Subscription startup waits for the ready
marker and keeps stdin open. Child process failures must not masquerade as delivery.
Unknown send outcomes remain terminal in the existing ledger.

## Consequences

An extra native binary is downloaded during dependency installation. Its exact version
and output contract must be tested together. The application supplies one public command
and one small skill; users do not install a second broad skill set or look up open_id.
Linux credentials use the CLI's storage implementation, so Feishu-only local installation
does not depend on a desktop keyring. WeChat and Relay retain their credential requirements.

No Webhook, SDK fallback, old config migration, or automatic channel switching is added.
Incoming resource downloads use a private temporary directory. The 100 MiB import limit
is checked after the CLI download completes; the upstream shortcut does not expose a
streaming byte cap, so temporary disk usage can exceed that limit before cleanup.
Mocked protocol tests and local binary smoke checks do not replace real-account delivery
or clean WSL service/restart acceptance.

## References

- [CLI quick start and authentication](https://github.com/larksuite/cli/blob/main/README.zh.md)
- [Message sending parameters and identity](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md)
- [Event subprocess contract](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)
