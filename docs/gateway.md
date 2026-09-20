# Codex secretary

The optional gateway connects the configured WeChat channel to one Codex CLI
conversation. Feishu supports outbound notifications only and has no secretary.
Install and authenticate Codex on the existing Hub, then choose a working directory:

```sh
send-message-gateway --channel wechat setup --cwd /absolute/workspace --permission workspace
send-message-gateway --channel wechat --json status
send-message-gateway --channel wechat service stop
```

`--codex /absolute/path/to/codex` selects an executable. Setup saves the resolved path
and PATH for the background service. Windows requires a native executable. Stop the
selected service before changing configuration. Workspace permissions are the default;
full access is an explicit setup or in-conversation permission choice.

Text and staged images/files from the channel's bound owner enter its conversation.
Images are local-image inputs; file paths are supplied as text so Codex can read them.
The first turn loads the connection skill, and subsequent turns preserve the current
thread. Restart restores it. `/newchat` starts a fresh thread. Send `/` for the live
command menu, including model/effort, permission, streaming, and interruption controls.
Internal reasoning and raw tool logs are not sent to the channel.

Replies return through WeChat. Session expiry blocks replies and requires `/recover`
from its bound user. Feishu cannot supply incoming commands or receive gateway replies.

Only an active gateway lease collects new input in that channel's inbox. Inbox records
and deduplication are bounded and expire. Stopping the gateway stops command collection;
accepted Codex work or already sent messages cannot be undone by interruption.
Attachments use generated private local paths, and stale files are pruned during storage
maintenance. There is no claim that an attachment was understood until Codex processes it.

The gateway runs independently of the desktop app using macOS LaunchAgent, Linux
systemd user service, or Windows scheduled task. Sleep, shutdown, connectivity, Codex
login and provider availability affect operation. Verify an incoming message, a Codex
turn, and the return message separately from service status.

The Agent installation procedure is packaged in
[the secretary skill reference](../.agents/skills/send-message/gateway.md).
