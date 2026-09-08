---
name: send-wechat
description: Send WeChat/Weixin messages or files when the user asks to 发微信, install, pair, or diagnose send-wechat, or set up its Codex 微信秘书 gateway.
---

# send-wechat

Use the CLI for the one user who bound it by QR. A single online Hub owns the
Weixin connection; paired clients forward requests to that Hub.

## Send

1. Use `send-wechat --json status` to check readiness. If missing or blocked,
   read [setup.md](setup.md) for installation, pairing, or recovery.
2. Send the user's concrete text or file without a duplicate confirmation:
   - Text: `printf '%s' 'message' | send-wechat --json send --stdin`
   - File: `send-wechat --json send --file PATH`
     Use safe shell quoting or a stdin-writing tool for arbitrary text.
3. Report the result: `accepted` means endpoint acceptance; `RESULT_UNKNOWN`
   means unknown. Never automatically replay an unknown send. Preserve its
   `--idempotency-key` if investigating it.

There is no recipient option, group send, or multi-account mode. If the user
names a different recipient, explain the bound-user scope. A vague test needs
concrete text or a file before sending. Never infer receipt or read status.

## Install, connect, diagnose

Read [setup.md](setup.md) only for these tasks. Complete routine installation
and fixes yourself; pause for browser authorization, QR/verification, the first
inbound activation message, passwords, or a required device choice.

After the requested installation or pairing is ready, follow setup.md's optional
secretary offer once. Ordinary sends and recovery alone do not trigger that offer.

On **every device, including the Hub and each client/WSL environment**, install
both the CLI and this entire skill directory into each Agent's user-level
(global) skills directory. Tell the user this is required so their Agent can
recognize future WeChat requests. Verify discovery in a fresh Agent session;
report an unverified reload separately from CLI readiness.

Pair through SSH or let the user paste a short-lived code into `setup --pair`.
Keep long-lived credentials, passwords, and device keys out of Agent output.
Pairing codes belong only in the chosen transfer channel; do not echo them into
reports or logs. Reset requires an explicit request and its terminal confirmation.

## Optional WeChat secretary

For an explicit request to enable, configure, stop, or diagnose the Codex secretary,
read [gateway.md](gateway.md). It runs on the existing Hub, consumes bound-user
text, and bridges one Codex CLI conversation. It shares the installed package with
the sending CLI; enabling its background service is a separate user choice.
Reuse prior consent, and preserve an already configured secretary and its thread.
