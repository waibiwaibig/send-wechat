# Install and connect

## Install on each device

1. Establish the OS user, platform and shell (native Windows and WSL are separate
   environments). Check `node --version` and `send-wechat --version`.
2. Install Node.js 24+ and an official GitHub Release `.tgz` from
   https://github.com/waibiwaibig/send-wechat/releases using
   `npm install --global /path/to/release.tgz`. Use the same release on Hub and
   clients. Honor a requested version; otherwise select the newest published
   release with an installable `.tgz`, including prereleases while the project
   is in preview. Inspect its tag and assets: `/releases/latest` and GitHub's
   latest-release API exclude prereleases. For a requested source checkout:
   `npm ci`, `npm run build`, then
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
replacement is authorized. Verify `SKILL.md`, `setup.md`, and `gateway.md` exist, implicit
invocation is enabled, and a fresh Agent session discovers `send-wechat`.
Do not send a test message merely to verify skill discovery. If a fresh session
cannot be opened, ask the user to reopen their Agent and report that check pending.

## First Hub

Run `status` and `doctor`, then `setup` if unconfigured. Use
`setup --qr-file PATH` with a fresh protected temporary image and show the QR.
The user completes Cloudflare authorization/account choice, QR or verification,
and the first message to the bot. Continue after these actions until `doctor`
passes and `status` is `ready`. Hub setup alone issues no pairing code.
Then finish onboarding below.

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
Then finish onboarding below.

## Finish onboarding: offer the secretary

Once the requested basic installation/pairing passes `doctor` and `status` is
`ready`, report that sending is available. If this task is only sending or
repairing an existing installation, stop there. During installation/onboarding,
offer the optional secretary once per conversation unless the user has already
accepted or declined it. Reuse an explicit request to set up the secretary as
consent and continue directly with [gateway.md](gateway.md).

Explain the choice briefly, for example:

> 基础微信发送已配置好。要不要顺便启用微信秘书？启用后，你给 bot 发文字就能与
> 一个固定的 Codex 会话对话，回答会逐段回到微信；它会在 Hub 上常驻运行，使用
> 你的 Codex 配置与账户。只用发送功能也可以。

Wait for the answer before installing Codex or starting the gateway. A decline
completes onboarding; silence leaves this optional step unconfigured and does
not block basic sending. Do not repeat the offer while configuring more devices
in the same conversation. If a secretary is already running on the Hub, report
that and reuse it. A configured but stopped service stays stopped unless the
user chooses to enable it.

The secretary always runs on the Hub. From a remote client, use an already
authorized SSH connection to the known Hub after consent; if Hub access is
missing, identify that specific next step. Do not create a second Hub or install
the secretary on a paired client. Check the selected package contains
`send-wechat-gateway` before claiming it can be enabled; if it is absent, explain
the release limitation and use gateway.md's package check.

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
