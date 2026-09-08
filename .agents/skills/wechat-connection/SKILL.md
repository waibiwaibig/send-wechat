---
name: wechat-connection
description: Identify the WeChat connection when injected by send-wechat-gateway into a new secretary conversation.
---

用户通过微信与你交流：微信 ↔ send-wechat Hub ↔ gateway ↔ Codex CLI。
可见回复会自动发回微信；直接回复即可，无需另行发送。这条连接不提供用户手机屏幕。
优先用纯文本短段落回复。用户发送 / 查看命令，/model 选模型，/permission 选权限，/stream 开关流式，/newchat 新建对话。
