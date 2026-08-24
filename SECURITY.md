# Security Policy

`send-wechat` 是预发布的非官方 CLI。本文描述产品边界，不构成对 Tencent、Cloudflare
或尚未完成人工验收的平台安装提供安全保证。

## 信任边界

工具信任已授权设备上的当前操作系统用户：该用户运行的任意进程都可调用 CLI，发送时
不再逐次确认。以下均不可信：其他本机用户、远程主机、用户文件路径、入站 Weixin
正文、Relay 帧和所有网络响应。管理员/root、当前系统账户、Tencent 或 Cloudflare
控制面被攻破不在本项目安全声明内。

每个 binding 恰有一台 Hub。只有 Hub 访问 Weixin 和保存 bot/context token。远端设备
只保存自己的 device ID/key；它永远不取得 Weixin 凭据或其他设备密钥。

## 个人 Relay

- Relay 是部署在用户自己 Cloudflare account 下的 Worker + SQLite Durable Object；
  项目方不运行共享服务、目录或 fallback。
- Hub 使用 outbound WebSocket 和独立 bearer token 认证。token 只进入 Authorization
  header，不进入 URL。
- 应用帧使用 AES-256-GCM 在远端设备与 Hub 间加密认证。Cloudflare 可见 endpoint、
  IP、时间、密文大小和流量模式，但看不到应用明文。
- Durable Object 只保留当前内存中的待完成请求和 Hub socket；不调用持久化 storage，
  不保存 payload、文件、设备凭据或 outbox。Hub 离线立即返回 `HUB_OFFLINE`。
- 文件以有界密文块转发，在 Hub owner-only 临时目录暂存；总长度与 SHA-256 验证完成后
  才交给发送层，完成或中止后删除。
- 邀请含高熵 bearer secret，10 分钟有效、只能加入一个设备。伪造、过期、不同请求的
  重放失败；同一请求的网络重试只返回原确认，不重复创建设备。

Cloudflare OAuth 由固定版本的官方 Wrangler 设备授权完成，并请求存入操作系统钥匙串。
部署时 Hub secret 只写入 owner-only 临时文件，Wrangler 返回后即删除。用户对 Cloudflare
account、配额、账单、availability 和 Worker 删除承担责任。

程序优先遵守当前进程的标准代理环境变量，否则读取 Windows、macOS 或 Linux 的原生
系统代理设置（包括静态代理、PAC/WPAD 和平台 bypass 规则）。用户配置的代理可观察
目标域名、连接时间和流量特征；若操作系统还信任该代理的 TLS 中间人证书，它也进入
Weixin 凭据路径的信任边界。远端设备与 Hub 间的应用层密文不因 HTTPS 代理而降级为
明文。

## 本机凭据与 IPC

- Weixin binding 和个人 Relay 分别使用系统原生凭据库中的固定独立条目；没有明文或
  环境变量 credential fallback。
- 非秘密状态采用 owner-only、严格 schema、原子替换的 JSON；Hub 幂等账本是固定 schema
  SQLite。未知版本不迁移、不 fallback。
- Hub IPC 使用 owner-scoped Unix socket（macOS/Linux）或用户专属 Windows named pipe，
  并要求 owner-readable 随机 capability；CLI/daemon 版本必须完全一致。
- 日志只允许安全元数据，不记录消息、文件内容、QR、token、邀请或密钥。

binding 与本机角色不可变。Hub `reset` 先确认删除记录的 Cloudflare Worker；失败则保留
本地 Relay 管理状态。成功后才停止服务并删除两类钥匙串凭据、状态、日志和临时文件。
远端 `reset` 只删除该设备的本机数据。

## 发送语义

只有绑定用户的新入站消息会建立或续期 24 小时 session window，正文被忽略。
`accepted` 只表示 Weixin endpoint 接受，不表示 delivered/read。没有权威结果时返回
`RESULT_UNKNOWN`，不得自动重放。幂等账本只在 Hub 本地抑制重复，不是服务端保证。

## 报告漏洞

请通过 [GitHub Security Advisories](https://github.com/waibiwaibig/send-wechat/security/advisories/new)
私密提交。请包含受影响版本/提交、复现步骤、影响和最小脱敏日志；不要附 QR、token、
邀请、密钥、消息、个人标识或真实文件。项目目前不承诺响应/修复时限或奖励计划。
