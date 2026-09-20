# Feishu group notifications

Feishu sends text only through a custom group robot Webhook. It needs no self-built
application, App ID, App Secret, recipient ID, event subscription, or chat permissions.
There is no Feishu secretary. WeChat retains image/file sending and chat interaction.

1. In the chosen Feishu group, add a custom robot and copy its Webhook URL. If signature
   verification is enabled, also obtain its signing secret. Existing keyword or IP
   restrictions must permit the messages and sending Hub.
2. Securely provide JSON through `setup --channels feishu --feishu-config-stdin`:
   `webhookUrl` and optional `signingSecret`. Use the official
   `https://open.feishu.cn/open-apis/bot/v2/hook/<UUID>` URL. Enter credentials directly
   into protected input; keep them out of chat, command arguments, and logs. The Hub
   stores them in native credential storage. The URL selects the destination group.
3. Setup and doctor validate configuration locally without sending a probe. They do
   not establish that the robot is enabled or the signature, keyword, and IP rules
   permit delivery. Use a user-authorized text send, then confirm device receipt.

Text is limited locally to 4,000 Unicode characters and a 20,000-byte JSON body.
Requests are serialized with at least 650 ms between attempts. Other senders using
this robot may share its quota. Platform throttling is reported without automatic
retry. Do not promise unlimited volume or infer receipt from API acceptance.

`--image` and `--file` return `FEISHU_TEXT_ONLY`; no upload or automatic channel switch
occurs. For explicit `--channel both`, WeChat can accept media while Feishu rejects it;
inspect both outcomes. A file URL may be sent as text when the user already has an
appropriate share link; never upload a file to a hosting service without authorization.
Webhook image messages using an existing image_key are outside this text-only product.

The returned clientMessageId is a local correlation ID, not a Feishu message ID.
The Hub's persistent ledger suppresses duplicates; accepted or unknown sends must
not be replayed. Do not send a real probe during routine setup or doctor.

Reference: [Custom bot usage guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot),
sections on creating a custom bot, security settings/signatures, and sending text.
