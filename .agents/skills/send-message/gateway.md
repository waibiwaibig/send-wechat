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
[feishu.md](feishu.md) for event subscriptions and permissions. For WeChat recovery
follow [wechat.md](wechat.md); its session restrictions also apply to secretary replies.

Check the selected service, incoming message, actual Codex turn, and channel reply
separately. A running service alone does not establish end-to-end readiness.
