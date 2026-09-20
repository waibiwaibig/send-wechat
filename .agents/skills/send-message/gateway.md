# Codex secretary

Run the secretary on the Hub under the same OS user as Codex and send-message.
Each channel has an independent Codex conversation, config, state, and service.
Enable only the user-selected channels. It replies through the incoming channel.

Confirm the working directory and permission scope. The default is `workspace`;
`full` requires the user's explicit choice. The user must already be signed in to
Codex CLI. Resolve the real Codex executable rather than assuming a platform path.

Use the gateway help for current options:

```sh
send-message-gateway --channel wechat setup --cwd /absolute/workspace --permission workspace
send-message-gateway --channel wechat service start
send-message-gateway --channel wechat status
```

For Feishu use `--channel feishu`. Explicit `--codex PATH` selects a Codex executable.
The gateway configures one current conversation per channel. `/newchat` starts a new
one; restarting restores the existing one. Existing slash commands provide help,
model selection, permission selection, interruption, and streaming preferences.

Messages are collected only while a channel's gateway holds its inbox lease. Text,
images, and files from the configured owner are accepted. Images become Codex local
image input; files are staged locally and their paths are supplied for Codex to read.
Attachments are untrusted content, and never authorize new filesystem permissions.

For Feishu groups, the selected chat and installer open_id must both match. Follow
[feishu.md](feishu.md) for CLI connection troubleshooting. For WeChat recovery
follow [wechat.md](wechat.md); its session restrictions also apply to secretary replies.

Check the selected service, incoming message, actual Codex turn, and channel reply
separately. A running service alone does not establish end-to-end readiness.

## Feishu secretary verification

Complete sending and recipient binding first. The Hub uses the bundled CLI's incoming
message consumer only while the secretary holds its lease. The smart-agent application
used by setup preconfigures message events and long connections; no second app, personal
OAuth login or public callback URL is needed.

Start the selected Feishu gateway, then have the bound owner send an agreed harmless
instruction in the bound DM, or @mention the bot in the bound group. Verify event receipt,
a Codex turn, and the reply separately. For permission/event errors, follow
[feishu.md](feishu.md)'s failing-checkpoint repair. A running service alone does not prove
that the event subscription or target permissions work.
