# Feishu channel

Use a self-built Feishu application with bot capability. A custom group Webhook does
not provide the application credentials, file API, or inbound events this product uses.

1. Create the application in the Feishu developer console and enable its bot.
2. Grant message sending (`im:message:send_as_bot`) and resource access (`im:resource`).
   For the secretary, subscribe to `im.message.receive_v1` using the long-connection
   mode and grant the relevant private-message or group-mention read permission.
3. Publish the app, include the owner in its availability scope, and add it to the
   selected notification group when using a group.
4. Securely provide JSON through `setup --channels feishu --feishu-config-stdin`:
   `appId`, `appSecret`, `receiveIdType` (`open_id` or `chat_id`), `receiveId`,
   and the installer's `ownerOpenId`. For DM, receiveId must equal ownerOpenId.
   Ask the user to enter secrets directly into protected input; keep them out of chat
   and command arguments. The Hub saves this configuration in native credential storage.
5. Run doctor and a user-authorized test. API acceptance, event subscription, and
   device notification are three separate checks.

Text is bounded to 4,000 Unicode characters, images to 10 MiB, files to 30 MiB.
Feishu has API rate limits and plan quotas; it is not an unlimited channel. API limits
and permissions may change: consult the linked official API sections when diagnosing.
The product does not apply WeChat's local 24-hour session gate to Feishu.

The secretary accepts only the configured owner's open_id. In a group it additionally
requires the configured chat_id; availability in a group does not authorize other
members to control Codex. Use @bot for group commands with mention-scoped permissions.

References:

- [Send message](https://open.feishu.cn/document/server-docs/im-v1/message/create): prerequisites, permissions, rate limits, receive_id_type.
- [Upload image](https://open.feishu.cn/document/server-docs/im-v1/image/create): request body and image size constraints.
- [Upload file](https://open.feishu.cn/document/server-docs/im-v1/file/create): file_type, file_name, and file size constraints.
- [Receive message](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive): sender identity, message resources, and deduplication by message_id.
- [Official Node SDK](https://github.com/larksuite/node-sdk#long-connection): local WebSocket event subscription.
