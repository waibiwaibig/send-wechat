---
name: send-wechat
description: Send WeChat/Weixin messages or files with send-wechat when the user asks to 发微信, send a WeChat/Weixin message or file, or install, set up, pair, or diagnose send-wechat.
---

# send-wechat

## Drive setup

When the user explicitly asks to install or set up this repository, first read the public onboarding
contract at https://github.com/waibiwaibig/send-wechat#readme. Then:

1. Establish the actual control plane and target platform before running platform commands. Distinguish
   native Windows from a Linux shell reached through SSH or WSL.
2. Install Node.js 24 and the newest GitHub Release `.tgz` for the target operating-system user. For a
   repository checkout, run `npm ci`, `npm run build`, then `npm install --global .`; do not pass an
   unbuilt GitHub source URL directly to npm. Keep installation and diagnostics user-scoped.
3. Run `send-wechat status` and `send-wechat doctor`. Continue through safe fixes and `setup`; do not
   hand routine commands back to the user.
4. Use `setup --qr-file` with a new protected temporary path and display that image in the conversation.
   Pause only for Cloudflare authorization/account choice, QR or Tencent verification, the binding user's
   first message, or an operating-system secure-storage prompt.
5. After the Hub is ready, ask whether the user wants another device. Generate no invitation when the
   answer is no.
6. With authorized SSH access, install remotely and stream the one-time invitation to
   `send-wechat setup --pair-stdin`. For a POSIX SSH target, use a direct pipeline equivalent to
   `send-wechat setup --pair-stdout | ssh TARGET 'send-wechat setup --pair-stdin'`; do not capture or
   echo the intermediate stdout. Never place an invitation in argv, chat, shell history, a normal log,
   or a screenshot. Without SSH, tell the Agent on the target device what outcome to complete and let the
   two Agents coordinate; the user should only perform a genuine account/security action.
7. Finish only after `doctor` and `status` confirm the intended machine is usable.

Do not request a password or credential in chat. Let the user type a password only into a native hidden
prompt. Do not update an existing installation unless the user asks for an update. Run `reset` only after
an explicit request; its interactive confirmation remains mandatory.

## Send

- There is one immutable binding user and no recipient option. Never invent `--to`, an HTTP endpoint,
  an MCP method, a library interface, or a second binding.
- A user request containing the concrete text or file is authorization for that payload. Do not add a
  duplicate confirmation. A vague request to "test sending" still needs the concrete non-sensitive payload.
- Prefer `printf '%s' 'message' | send-wechat --json send --stdin` for programmatic text and
  `send-wechat --json send --file PATH` for files. Put global `--json` before the command.
- Report `accepted` as endpoint acceptance. Do not claim delivered/read. Report `RESULT_UNKNOWN` as
  unknown and do not replay automatically.

Never read, print, copy, or inspect Weixin credentials, Cloudflare tokens, native credential-store entries,
device keys, pairing invitations, IPC capabilities, or secret-bearing environment variables.
