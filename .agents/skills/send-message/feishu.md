# Feishu: scan, open the chat, send a message

Feishu uses the bundled official `@larksuite/cli` as the application bot. Setup owns
an isolated CLI profile. Use `send-message` commands; credentials and recipient IDs
stay on the Hub. The app creator connects the destination by sending an ordinary
message after setup shows that the listener is ready.

## Connect

1. Use the user's private bot conversation by default. For a requested group, add
   `--feishu-target group`. Keep the channel/default choices from [setup.md](setup.md).
2. Run `send-message setup --channels feishu` (or the chosen dual-channel command).
   Keep it running and show the official app-creation link/QR. The user scans and
   creates the dedicated app. Setup queries this app's creator identity; existing
   complete bindings are verified and reused.
3. Wait for **连接已就绪**. Show the actual bot name and the full opening instructions
   from setup. For a private chat, present the emitted URL as a clickable
   **打开机器人私聊** link. The user opens it on the computer or phone running Feishu;
   WSL/SSH only runs the installation process. They use the account and enterprise
   that created the app, then send any message, such as **你好**, within ten minutes.
   For a group, follow the group steps below and send **@bot plus any text**.
4. Wait for **接收人已绑定** and successful setup. Continue [setup.md](setup.md)'s
   delivery test in the exact connected conversation. API acceptance and user receipt
   are separate checkpoints.

### Opening the private chat

Always include a concrete route, even when the user already scanned successfully:

- **Direct link:** show the exact `https://applink.feishu.cn/client/bot/open?appId=...`
  emitted by setup. If the terminal cannot open links, copy it into a browser on the
  user's Feishu device and allow it to open Feishu.
- **Computer:** open Feishu, use the top search box to search the displayed bot name,
  select the matching application/robot, and choose **发消息** to enter the chat.
- **Phone:** open Feishu's **消息** page, use its search entry to search the displayed
  bot name, select the matching application/robot, and choose **发消息**.

The example **你好** is ordinary text. Setup has no random binding code to copy.
Show only the app name and URL actually returned by setup; never invent a recipient.

### Connecting a group

Open the target group's settings, choose **群机器人 → 添加机器人**, search the displayed
bot name and add it. The app creator then sends **@that bot plus any text** in this
one group. Setup checks both the creator's identity and the bot mention, then stores
that group as the fixed destination.

## Resume or change the target

After timeout, rerun setup and send a new ordinary message once the listener is ready.
The saved CLI profile is reused. To replace a destination explicitly, use
`send-message setup --feishu-rebind` with the desired `--feishu-target dm|group`.
The old binding remains intact until a valid fresh message from the app creator is
received. Subsequent secretary messages must match the saved owner and conversation.

## Repair the failing checkpoint

- **CLI missing/install failure:** repair the pinned package and native-binary download.
- **Scan link expired:** rerun setup and show its new registration link. Finish any
  organization approval before claiming successful app creation.
- **Chat link or search cannot find the bot:** confirm the selected Feishu account and
  enterprise, then inspect the app's publication/availability in the developer console.
- **Creator identity unavailable:** check the reported API/configuration error. Setup
  needs the current app's creator information to authorize the first message.
- **Listener fails:** check the app's bot capability, message-receive event and
  long-connection settings. Report the safe upstream code and the relevant console step.
- **Message ignored:** send a fresh message after **连接已就绪**, using the app creator's
  account in the chosen chat type. A group message must mention this bot exactly once
  and contain text after the mention.
- **Send rejected:** check the safe API code, app availability/group membership,
  send-as-bot permission and media resource permission. Keep the chosen channel.
- **Unknown send outcome:** inspect the conversation and recorded cause before another send.

Text is limited to 4,000 characters; images to 10 MiB and files to 30 MiB. Personal
OAuth login is unnecessary for this app-bot flow. The optional [secretary](gateway.md)
accepts only the connected owner's messages.

Official references:
[app information — creator identity and own-app lookup](https://open.feishu.cn/document/server-docs/application-v6/application/get),
[bot-opening AppLink — showRobot example](https://www.feishu.cn/content/7270877743058698268),
[CLI events — subprocess contract](https://github.com/larksuite/cli/blob/v1.0.96/skills/lark-event/SKILL.md).
