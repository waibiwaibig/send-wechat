# Install and configure

## Choose the installation

Ask the user which channels to install: WeChat, Feishu, or both. For both, ask which
channel is the default. Separately ask whether this is one computer or several.
Use prior answers rather than asking again. Single-machine setup needs no Cloudflare.

On every device install Node.js 24+ and this repository's current package. For source
installation run `npm ci`, `npm run build`, then `npm install --global .`.
Keep Hub and remote clients on the same package version. The current source uses
`send-message`; old `send-wechat` release artifacts do not provide this interface.

Copy the entire package `.agents/skills/send-message/` directory into the Agent's
user-level skill directory, such as `~/.agents/skills/send-message/` or
`~/.codex/skills/send-message/`. Do this for each Agent on every device. Verify the
CLI with `send-message --version` and skill discovery in a fresh Agent session.

## Configure the Hub

- WeChat: `send-message setup --channels wechat`; follow [wechat.md](wechat.md).
- Feishu: `send-message setup --channels feishu --feishu-config-stdin`;
  follow [feishu.md](feishu.md) and supply the protected configuration through stdin.
- Both: use `--channels both --default-channel wechat|feishu`, adding
  `--feishu-config-stdin` when the Feishu Webhook credentials are new.

For QR rendering to a protected image use `--qr-file PATH`. Display it to the user,
wait for their scan and verification, and complete the initial inbound activation.
Secrets are never command arguments. `doctor` checks local Feishu configuration without probing the Webhook; a user-authorized test
with `send --channel CHANNEL` establishes API acceptance for that selected channel.
Ask the user to confirm device receipt when that is part of the requested outcome.

Re-run setup with an explicit channel selection to change configuration. Save the
intended default only when it belongs to the configured channels. Do not silently
switch providers to repair a failure.

## Add devices

The Hub must stay online. Enable the user's Cloudflare Relay with `setup --relay`.
The browser OAuth/account authorization belongs to the user. Then transfer a one-use,
short-lived invitation over an authorized SSH connection:

```sh
send-message setup --pair-stdout | ssh TARGET 'send-message setup --pair-stdin'
```

Alternatively the user pastes it into `send-message setup --pair`. Keep the invitation
out of logs and chat reports. Clients have only their own device credential and never
receive provider credentials. Run `doctor` and `status` on the new client. Hub offline
means delivery is unavailable; there is no durable outgoing queue or alternate channel.

## Offer optional features

Once basic delivery is verified, separately offer:

1. Codex root-task completion and question notifications: [notifications.md](notifications.md).
2. The WeChat Codex secretary, only when WeChat is configured: [gateway.md](gateway.md).
   Feishu has no incoming chat or secretary support.

Ask only for missing choices, reuse existing consent, and leave declined features off.
Routine diagnosis and individual sends do not trigger these offers.
