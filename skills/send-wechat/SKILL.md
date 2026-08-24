---
name: send-wechat
description: Use the installed send-wechat CLI for the one explicitly bound Weixin user; not a general Weixin client or a credential-management workflow.
---

# send-wechat

Use only the installed `send-wechat` executable and its documented public commands.

- Begin with `send-wechat status` and `send-wechat doctor`. If either reports that the daemon, binding, session, or platform prerequisites are not ready, explain the result and stop before sending.
- For programmatic calls, put global `--json` before the command and parse the schema-versioned final result. Prefer stdin for text, for example `printf '%s' 'message' | send-wechat --json send --stdin`; use `--file PATH` for a file.
- There is one immutable binding user and no recipient option. Do not invent a recipient, pairing challenge, protocol call, HTTP endpoint, or library interface.
- `login` requires the user to scan a real QR code. Do not perform login or reset without the user's explicit request.
- Sending text or a file is an external side effect. Obtain explicit user authorization for that specific payload before invoking `send`; never infer authorization from a status check.
- Report `accepted` exactly as endpoint acceptance, never as delivered or read. Report `result_unknown` as unknown and do not replay it automatically.
- Never read, request, print, copy, or inspect Weixin credentials, native credential-store entries, IPC capabilities, or secret-bearing environment variables.
