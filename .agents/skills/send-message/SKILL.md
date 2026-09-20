---
name: send-message
description: Send text, images, or files when asked to 发微信, 发飞书, or send through WeChat or Feishu; install, configure, pair, diagnose send-message, or configure its Codex notifications and secretary.
---

# send-message

Use `send-message` with the user's configured channels and fixed recipients.
The local Hub owns provider credentials. Remote clients forward encrypted requests
through the user's optional Relay.

## Send

1. Run `send-message --json status`. Inspect each requested channel separately.
   For setup or errors read [setup.md](setup.md) and the relevant channel reference:
   [wechat.md](wechat.md) or [feishu.md](feishu.md).
2. Send the requested content. Omit `--channel` to use the configured default;
   use `--channel wechat`, `--channel feishu`, or explicitly requested `--channel both`.
   - Text: `send-message --json send --stdin`, supplying the exact text through stdin.
   - Image: `send-message --json send --image PATH`.
   - File: `send-message --json send --file PATH`.
3. Read every `result.channels` entry. `accepted` confirms API acceptance only.
   Preserve the idempotency key during investigation. Unknown results are never
   automatically resent; an accepted channel must not be repeated to repair another.

The user's send request authorizes sending its specified content. Each channel has
one configured recipient: the QR-bound WeChat user, or the configured Feishu DM/group.
Changing recipients requires configuration. Never choose another channel after failure.
For `both`, report partial success explicitly. Device notifications and human receipt
require separate evidence.

## Installation and optional features

Read [setup.md](setup.md) for installation, pairing, channel selection, and recovery.
Ask which channels to install: WeChat, Feishu, or both. Both requires a default channel.
Install this complete skill directory in each Agent's user-level skill directory on
all Hub/client devices. npm installation alone does not register an Agent skill.
Verify discovery in a fresh Agent session separately from CLI readiness.

After basic delivery works, offer Codex task notifications and the Codex secretary as
separate opt-in features. Reuse existing consent. See [gateway.md](gateway.md) for
secretary setup and [notifications.md](notifications.md) for task notifications.

Keep credentials out of argv, logs, committed files, and reports. Use protected stdin
for Feishu app configuration and short-lived Relay pairing invitations. Perform reset
only at the user's request and complete its terminal confirmation.
