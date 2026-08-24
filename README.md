# send-wechat

`send-wechat` 是一个非官方、独立、跨平台的 CLI：扫码绑定一个 Weixin 用户后，
你可以从自己的 macOS、Windows 或 GNU/Linux 设备向这个唯一的绑定用户发送文本或文件。

项目方不运行公共服务器。首次设置会在你自己的 Cloudflare 账户中部署一个个人
Worker + Durable Object；只有一台 Hub 连接 Weixin，其他设备通过个人 Relay 把端到端
加密的实时请求转给 Hub。消息与文件不在 Relay 上持久化。

> **0.1.0-rc.1 验证状态：** macOS arm64 Hub 的安装、真实 Cloudflare deployment、Weixin
> QR、入站激活和文本发送已于 2026-08-24 完成人工验收。原生 Windows 与 GNU/Linux
> 的 CI 已通过，但真实系统安装、凭据库、后台服务及发送验收仍待完成；Windows/WSL
> 混合运行不在支持范围内。

## 一条命令开始

要求 Node.js 24。RC 验收期间从公开 GitHub Release 安装：

```sh
npm install --global https://github.com/waibiwaibig/send-wechat/releases/download/v0.1.0-rc.1/send-wechat-0.1.0-rc.1.tgz
send-wechat setup
```

完成 Windows 与 GNU/Linux 真实验收后，最终 `0.1.0` 将发布到 npm `latest`，届时安装
命令会缩短为 `npm install --global send-wechat`。

首次 `setup` 会依次：

1. 用官方 Wrangler 打开一次 Cloudflare 设备授权，并把授权存入系统钥匙串；
2. 在你的账户中部署个人 Relay 到 `workers.dev`；若该账户从未使用过 Workers，Wrangler
   会在同一个命令中让你命名并确认一次 `workers.dev` 子域；
3. 安装并启动当前用户的 Hub 后台服务；
4. 显示 Weixin QR，等待扫码；
5. 等待绑定用户向新出现的 ClawBot 发一条消息，使会话进入 `ready`，随后由
   `send-wechat` 自动回复一次“已连接”确认；
6. 打印一个 10 分钟有效、只能使用一次的新设备邀请。

如果 Cloudflare 账户有多个 account，`setup` 会让你选择，不会擅自部署。Cloudflare
账户、免费额度、可用性和删除权都属于用户；本项目没有共享 Relay、全局目录或 LAN
配置 fallback。

## 连接另一台设备

在 Hub 上再次运行：

```sh
send-wechat setup
```

把打印出的完整命令复制到新设备执行：

```sh
send-wechat setup --pair 'sw1.…'
```

新设备只保存自己的设备密钥，不安装 Weixin daemon，也不会取得 QR、bot token、
context token 或其他设备的密钥。邀请过期、伪造、被其他请求使用或重放都会失败。

## 发送与程序调用

```sh
send-wechat send --text '一条消息'
send-wechat send --file ./report.pdf
printf '%s' '来自程序的消息' | send-wechat --json send --stdin
send-wechat --json status
send-wechat doctor
```

Hub 和远端设备使用同一套 CLI/JSON 合约。远端文件以最多 512 KiB 的端到端加密分块
实时转发，只有 Hub 本机暂存；Hub 校验总长度和 SHA-256 后才发送并删除暂存文件。
Cloudflare 只能看到路由元数据、密文大小、时间和来源 IP。

`accepted` 只表示 Weixin `sendmessage` endpoint 返回 HTTP success 且业务结果为零，
不表示 delivered 或 read。如果请求已经开始但没有权威结果，返回 `RESULT_UNKNOWN`，
不会自动重放。调用程序应复用同一个 `--idempotency-key`，不要用新 key 猜测重试。

退出码：`0` 成功，`2` 用法/本地输入，`3` 环境、Hub、Relay、登录或会话未就绪，
`4` 发送结果/冲突/背压需调用方处理，`5` 本地内部失败。

## 公共命令

```text
send-wechat setup [--pair INVITATION] [--qr-file PATH]
send-wechat send (--text TEXT | --stdin | --file PATH) [--idempotency-key KEY]
send-wechat status
send-wechat doctor
send-wechat reset
send-wechat service install|start|stop|restart|uninstall
```

`setup` 是唯一 onboarding 命令；旧 `login` 没有 alias。远端设备没有本地服务，因而
不能执行 `service` 操作。工具没有 `--to`、群发、多账户、GUI、MCP、公共 HTTP API、
受支持的库接口或 LAN listener。

`reset` 是交互式操作。Hub 会先确认删除其 Cloudflare Worker；删除失败时保留本地管理
状态以便重试。删除成功后才停止服务并清除本机绑定、凭据、日志和状态。远端设备只清除
自己的本机凭据与状态。

## 平台与会话

支持 macOS arm64/x64、Windows x64/arm64、GNU/Linux glibc x64/arm64。Linux 需要
Secret Service provider、systemd user manager 和 `XDG_RUNTIME_DIR`。Alpine/musl、
非 systemd Linux、32 位系统、FreeBSD 和 Windows/WSL 混合运行不在支持矩阵内。
所有 Node 出站请求和 Hub WebSocket 都优先遵守标准 `HTTP_PROXY`、`HTTPS_PROXY` 与
`NO_PROXY` 环境变量；这些变量未设置时，自动使用 Windows、macOS 或 Linux 的原生
系统代理、PAC/WPAD 与 bypass 规则，不要求用户为后台服务手工复制代理配置。

只有绑定用户的新入站消息能建立或续期 24 小时会话窗口。第 22–24 小时为
`renewal_due`，24 小时后 fail closed，直到再次收到该用户的新消息。入站正文被忽略且
不存储。每次绑定激活仅在首次从 `awaiting_message` 进入 `ready` 时自动回复一次连接确认，
普通续期不回复；Hub 的七天幂等账本只用于本地去重，不是 Weixin 服务端送达保证。

## 验收与安全

- 最终真实环境步骤：[`docs/manual-acceptance.md`](docs/manual-acceptance.md)
- 信任边界与漏洞报告：[`SECURITY.md`](SECURITY.md)
- 协议来源和许可证：[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- 领域与架构决策：[`CONTEXT.md`](CONTEXT.md)、[`docs/adr/`](docs/adr/)
