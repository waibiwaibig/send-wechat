# Connect from a repository link

Own the setup until the user confirms receipt. Ask one unresolved question at a time,
reuse prior answers, and retain a short nonsecret progress note when waiting.

## 1. Choose

Ask **WeChat, Feishu, or both**. WeChat needs QR activation and ongoing session renewal;
Feishu uses a guided app-creation scan and one ordinary message from the app creator to select the conversation. Both requires
an explicit default channel. Confirm the installation machine; a previously mentioned
remote host alone does not authorize installing there. Start with a local Hub.

## 2. Install on that machine

Inspect OS, Node/npm, existing installation/version, and repository Git status.
Preserve unrelated changes. Use Node.js 24+, clone this repository if necessary, then
run `npm ci`, `npm run build`, and `npm install --global .`. Verify the installed version
and `send-message setup --help`. The pinned official Feishu CLI is a package dependency;
its install script downloads the native binary. Installation needs network access to
npm and the official release download. Fix an install failure before account setup.

Copy the **whole** `.agents/skills/send-message/` directory to the selected Agent's
user-level skill directory, inspecting any existing copy first. Typical destinations:
`~/.agents/skills/send-message/` (Codex), `~/.claude/skills/send-message/` (Claude Code).
Verify discovery in a fresh Agent session; continue this session by reading it directly.
Do not separately install the broad official Feishu skill collection for this workflow.

On WSL/Linux, check the user service session/systemd before starting the Hub. Native
credential storage is required for WeChat or a personal Relay. Feishu-only local mode
uses the official CLI's Linux credential storage and needs no desktop keyring. Use the
same OS user for setup and the service. WSL needs to remain running to send notifications.

## 3. Connect the selected channels

Read only the selected provider guide: [WeChat](wechat.md), [Feishu](feishu.md), or both.
Run one setup with the chosen channels:

```sh
send-message setup --channels wechat
send-message setup --channels feishu
send-message setup --channels both --default-channel feishu
```

For both, use the user's actual default. Setup connects Feishu first, then handles
WeChat activation. Keep the process alive while showing each current link/QR/prompt.
Use `--qr-file PATH` for the WeChat QR when a terminal image is inconvenient. On an
existing installation, preserve its channel selection; rerun `setup` without
`--channels` to reuse it. Finish with successful setup and a bound recipient per channel.

## 4. Verify delivery

Run `send-message doctor` and `send-message --json status`. With authorization, send a
short labelled setup test through each chosen channel; reuse previous test consent.
Ask the user to confirm receipt in the intended conversation. If images/files are part
of their intended use, test harmless agreed samples too. `accepted` alone does not finish
setup. Phone/Mac notification banners are a separate check when requested.

For a failure, keep its safe error code and idempotency key, repair that step, and resume.
Do not reset a working channel or retry an unknown send automatically. Report machine,
version, channels/default, recipient, confirmed receipt, and remaining unverified items.

## 5. Choose whether to enable the secretary

After confirmed receipt, ask once: “要开启秘书吗？开启后，你可以直接在微信或飞书里发消息，让 Codex 处理并回复。”
Reuse an explicit earlier choice. If declined, leave the secretary off and skip role
setup. If enabled, follow [gateway.md](gateway.md), including its optional role question
before starting the service. A direct secretary setup request already supplies the
enablement choice. Ordinary sending and repair do not repeat this onboarding offer.

## 6. Other optional extensions

Offer [notifications](notifications.md) separately from the secretary. Notification-only
use does not run a persistent incoming-message consumer; Feishu uses one temporarily
during binding.

Only for explicitly requested additional devices: choose an always-online Hub and run
`send-message setup --relay`. Guide Cloudflare authorization/account selection. Install
matching sender versions and the entire skill directory on authorized clients. Transfer
a short-lived invitation over authorized SSH without exposing it in chat or argv:

```sh
send-message setup --pair-stdout | ssh TARGET 'send-message setup --pair-stdin'
```

Alternatively use interactive pairing. Verify a send from each client. Clients hold
only device credentials; an offline Hub cannot deliver.
