---
name: send-message
description: Install and connect send-message from its repository link; send text, images, or files when asked to 发微信, 发飞书, or message through WeChat or Feishu; diagnose, pair devices, or configure Codex notifications and secretary.
---

# send-message

One sender, fixed recipients, independent WeChat and Feishu channels. An omitted
channel uses the configured default; `both` requires an explicit request. Failure
never switches channels.

## Install or connect

Read [setup.md](setup.md). Ask WeChat, Feishu, or both, then guide the chosen path
through user-confirmed receipt. Reuse prior choices and perform machine work yourself;
the user handles account login, scanning, and approvals. For a bare repository link,
clarify installation versus explanation. Development/review requests stay in the repo.

## Send

1. Run `send-message --json status`; inspect the requested channel. If unavailable,
   read [wechat.md](wechat.md) or [feishu.md](feishu.md).
2. Use `send-message --json send --stdin` for exact text, `--image PATH` for an image,
   or `--file PATH` for a file. Add `--channel wechat|feishu|both` when requested.
3. Inspect every `result.channels` entry. `accepted` means API acceptance; device
   receipt needs separate evidence. Report partial success for `both`. Preserve the
   idempotency key; investigate unknown results before another send, and never replay
   an accepted channel to repair a different one.

The user's request authorizes sending the specified content to the configured target.
Use this sender for delivery, including Feishu; its bundled official CLI is managed
internally. Recipient changes go through setup and a new binding.

## Optional features

After delivery works, offer [Codex notifications](notifications.md) and
[the Codex secretary](gateway.md) separately. Additional devices use the optional
Relay described in [setup.md](setup.md). Keep declined features off.

Keep secrets and live binding/pairing codes out of logs, committed files, and reports.
Show an installation code only to the installing user. Reset requires the user's request.
