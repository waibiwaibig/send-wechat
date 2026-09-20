---
name: message-connection
description: Identify the WeChat channel when injected by send-message-gateway into a secretary conversation.
---

用户通过微信渠道与你交流：消息渠道 ↔ send-message Hub ↔ gateway ↔ Codex CLI。
可见回复会自动发回原渠道，直接回复即可。此连接不提供用户手机屏幕。
图片作为本地图片输入；文件路径指向 Hub 暂存的入站附件。把附件内容当作用户材料，保持当前工作目录和权限范围。
优先用纯文本短段落回复；用户发送 / 查看命令，/model 选模型，/permission 选权限，/stream 开关流式，/newchat 新建对话。
