# Install and connect

## Install on each device

1. Establish the OS user, platform and shell (native Windows and WSL are separate
   environments). Check `node --version` and `send-wechat --version`.
2. Install Node.js 24+ and the latest official GitHub Release `.tgz` from
   https://github.com/waibiwaibig/send-wechat/releases/latest using
   `npm install --global /path/to/release.tgz`. Use the same release on Hub and
   clients. For a requested source checkout: `npm ci`, `npm run build`, then
   `npm install --global .`. Never npm-install an unbuilt GitHub source URL.
   Update an existing installation when the user requests an update or fix that
   requires it; explain the version change.
3. Install the **whole** `.agents/skills/send-wechat/` directory from that package
   in every Agent's user-level skills directory on this device. Codex uses
   `$HOME/.agents/skills/send-wechat/`; Claude Code uses
   `$HOME/.claude/skills/send-wechat/`. Check other Agents' official paths.

POSIX example for Codex after npm installation:

```sh
mkdir -p "$HOME/.agents/skills"
cp -R "$(npm root --global)/send-wechat/.agents/skills/send-wechat" "$HOME/.agents/skills/"
```

PowerShell example for Codex:

```powershell
$skillSource = Join-Path (npm root --global) 'send-wechat/.agents/skills/send-wechat'
$skillParent = Join-Path $HOME '.agents/skills'
New-Item -ItemType Directory -Force $skillParent | Out-Null
Copy-Item -Recurse -Force $skillSource $skillParent
```

Inspect an existing destination first; avoid nesting copies or retaining stale
resources when replacing a prior version. Preserve local customizations unless
replacement is authorized. Verify `SKILL.md` and `setup.md` exist, implicit
invocation is enabled, and a fresh Agent session discovers `send-wechat`.
Do not send a test message merely to verify skill discovery. If a fresh session
cannot be opened, ask the user to reopen their Agent and report that check pending.

## First Hub

Run `status` and `doctor`, then `setup` if unconfigured. Use
`setup --qr-file PATH` with a fresh protected temporary image and show the QR.
The user completes Cloudflare authorization/account choice, QR or verification,
and the first message to the bot. Continue after these actions until `doctor`
passes and `status` is `ready`. Hub setup alone issues no pairing code.

## Additional device

Install CLI **and global skill on both ends first**. Reuse an existing Hub.
Clients need no Cloudflare login, QR, or local daemon. Verify a complete SSH
command and CLI availability before pairing; use the installed executable's
absolute path if the SSH PATH omits it.

From Hub: `send-wechat setup --pair-stdout | ssh TARGET 'send-wechat setup --pair-stdin'`.
From client: `ssh HUB 'send-wechat setup --pair-stdout' | send-wechat setup --pair-stdin`.
Do not capture the intermediate invitation or enable shell tracing. Pairing network
requests time out after ten seconds each, with at most three attempts and short
backoffs (about 31 seconds total); progress goes to stderr.

Without SSH, the user runs `setup --pair-stdout` on the Hub and copies its whole
line into the terminal prompt from `setup --pair` on the client, then presses
Enter. A private transfer channel, including the user's own WeChat chat, is fine.
If asked to send a code through WeChat, use the existing CLI and send authorization;
never automatically send one during setup. Codes expire after ten minutes and
join one device. Do not put a code in command arguments, diagnostic logs, or reports.

Finish with client `doctor` and `status`. Tell the user which machines have CLI,
global skill and readiness verified; identify any unverified device separately.

## Recovery

- `SESSION_EXPIRED` / `awaiting_message`: ask the user to send a message to the bot.
- `HUB_OFFLINE`: restore the Hub's connection/service; clients do not run services.
- `VERSION_MISMATCH`: align CLI/Hub service versions and restart the Hub service.
- Client credential/installation failure: inspect `doctor`'s local failing layer.
  macOS/Linux clients use owner-only files (directory `0700`, file `0600`). Do not
  inspect their contents. A reported local-save failure happens before the Hub
  accepts the invitation; repair the local path and retry within its validity.
- Broken/old macOS client or leftover client setup: explain `reset --local`, get
  the user's reset authorization/terminal `RESET`, then pair again. This removes
  local client state and stale service configuration; it refuses a known Hub and
  does not revoke the old device key on the Hub. It does not access old Keychain
  records. No credential migration or fallback reader is supported.
- Full Hub `reset` removes the user's cloud deployment and binding. Use only when
  explicitly requested. Never use a Hub reset to repair a remote client.

Long-lived secrets and system passwords stay in their storage/native prompts.
Keep diagnosis to error codes, permissions, executable paths and service status.
