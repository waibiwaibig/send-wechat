# Configure the optional Codex secretary

Use this workflow after the user chooses the secretary, or explicitly asks to
configure or repair it. Ordinary installation consent covers the base sender;
the optional secretary has its own choice. Reuse that choice once given.

The secretary uses the existing Hub's Weixin connection and one Codex CLI
conversation. It runs independently of the Codex desktop app. Plain Weixin text
becomes Codex input. Secretary turns default to full access; `/permission`
selects full, workspace-write or read-only execution without changing global
Codex configuration. Replies arrive as successive messages. `/newchat` selects
blank conversation context; it preserves Codex configuration and tools.

## Check the Hub and package

1. Work as the same OS user that owns the existing Hub. Check
   `send-wechat --json doctor` and `send-wechat --json status`; complete basic
   setup or recovery using [setup.md](setup.md) if needed. On a paired client,
   operate the known Hub through authorized SSH or ask for the missing Hub
   access. Do not start another Hub or install a client-side secretary.
2. Check `send-wechat-gateway --version` and `send-wechat-gateway --json status`.
   Inspect a missing command's installed package/bin and PATH before diagnosing
   a release gap. A release must actually ship `dist/gateway/bin.js` and the
   `send-wechat-gateway` bin entry. An older release can still provide basic
   sending. Check published release assets for a version with the gateway; if
   none exists, report the addon as unavailable from Releases. Build from source
   only when the user has requested or accepted that installation source.
3. Reuse a responsive existing gateway. For a configured stopped gateway, use
   `send-wechat-gateway service start` after the user's enable request. Preserve
   its current thread and working directory. Use `setup` for first configuration
   or a requested configuration change; stop a running gateway before changing
   its configuration. Do not reset the Hub or send `/newchat` during setup.

## Prepare Codex for first configuration

Check `codex --version`, `codex login status`, and `codex app-server --help` on
the Hub. Desktop availability alone does not verify the CLI. If Codex is missing,
install it using the current [official Codex CLI instructions](https://learn.chatgpt.com/docs/codex/cli).
Use `codex login` when authentication is missing; the user completes the login
or device authorization. Keep credentials in Codex's own storage and native
prompts. Preserve an explicitly configured alternate provider; do not replace it
just because ChatGPT login is absent. Never copy tokens into gateway settings.

Use the user's chosen Codex working directory. If none is established, ask which
directory the secretary should work in; suggest a dedicated `~/wechat-secretary`
directory. Resolve `~` to the Hub user's home, create the chosen directory if
needed, and use its absolute path. This directory selects the files and project
instructions Codex works with. Preserve the existing model until the user selects
another one with `/model`. Explain the secretary's full-access default and the
`/permission` choices. Do not change global Codex permissions during setup.

## Start and verify

After installing/updating the send-wechat package on the Hub, restart its daemon
so the inbox interface is loaded: `send-wechat service restart`. Align paired
clients with the chosen release using [setup.md](setup.md). For first secretary
configuration run:

```sh
send-wechat-gateway --json setup --cwd /absolute/chosen/directory
send-wechat-gateway --json status
```

Use safe quoting for the real path. `--codex /absolute/path/to/codex` selects an
executable when PATH lookup is insufficient. Windows requires native `codex.exe`,
not a `.cmd` or `.bat` wrapper; locate the installed native executable.

`setup` installs and starts the separate gateway service. Check status for up to
30 seconds, at short intervals: `configured: true`, `service.running: true`,
`responsive: true`, and `runtime.phase: ready` establish service readiness.
Inspect `runtime.lastError` and explain any error. A null `threadId` before the
first message is expected. A successful setup command or heartbeat does not
prove model access or Weixin receipt.

For an end-to-end check, ask the user to send the bot a concrete harmless input,
such as `请只回复：秘书已连接`, and confirm what arrives on the phone. This input
initiates the gateway reply. Do not initiate an unrelated outbound test message.
Report basic sending, gateway service readiness, and real conversation receipt
separately. If no test input/receipt is available, leave that verification pending.

## Explain operation and handle failures

- New text interrupts the active reply. Actions already executed and Weixin
  messages already submitted can still take effect. Unknown outcomes are never
  automatically replayed.
- `/` or `/help` returns the command menu after sending; the Weixin input box
  does not provide gateway command autocomplete.
- `/model` lists current Codex models and efforts. `/model astra low` selects
  a supported combination for the next reply; unique model aliases are accepted.
- `/permission` lists modes. `/permission full`, `/permission workspace` and
  `/permission read-only` stop active execution before saving the new mode.
- `/stream` shows the delivery mode; `/stream on` enables incremental blocks
  and `/stream off` waits for each visible message to complete. The default is
  on. Changes apply to the next reply without interrupting the active one;
  selections persist across restart. Long completed messages still split at
  the transport limit.
- `/newchat` clears the current conversation pointer and reports the preserved
  model, permission and stream setting. The next text starts the fresh thread and injects the
  short connection skill. Gateway restart normally resumes the existing thread.
- `send-wechat-gateway service stop` stops the secretary while ordinary sending
  remains available. Use `service start` to enable it again, and `service uninstall`
  to remove its service when requested. Do not use base Hub reset for this.
- Permission approvals and interactive forms requiring a richer Codex client
  are declined with a notice. Do not promise desktop-only tools through the CLI.
- If the service never becomes responsive, diagnose the reported error, Codex
  executable, Hub interface, and platform service. Avoid restart loops or repeated
  model inputs. The Hub, computer, and network must remain available.
