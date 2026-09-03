# send-wechat

把下面这句话发给 Codex、Claude Code 或其他能运行终端命令的 Agent：

> 请安装并设置 https://github.com/waibiwaibig/send-wechat

Agent 会完成安装、环境检查、个人 Relay、后台服务和诊断。你只在这些步骤接管：

1. 在浏览器确认自己的 Cloudflare 账户；
2. 扫描 Weixin 二维码，并按提示给新出现的 bot 发一条消息；
3. 回答是否连接其他设备；系统要求密码时在本机安全提示中输入。

完成后，在任何已连接设备上告诉 Agent 要发送的文字或文件即可。具体消息或文件就是
本次发送授权；`send-wechat` 始终只发给扫码绑定的那个 Weixin 用户。

`send-wechat` 是非官方、独立、跨平台的 Agent 工具。项目方不运行公共服务；每位用户
在自己的 Cloudflare 账户中拥有一个个人 Relay，消息和文件只作为端到端加密的实时请求
经过 Relay，不会在 Relay 持久化。

> **当前验证状态：** 2026-08-24 已在 macOS arm64 完成真实 Cloudflare deployment、
> Weixin QR、入站激活和文本发送。原生 Windows、GNU/Linux Hub、WSL/headless Linux
> 远端客户端及真实跨设备文件发送仍需完成人工验收，详见
> [`docs/manual-acceptance.md`](docs/manual-acceptance.md)。

## Agent 执行契约

用户明确说“安装”或“设置”并给出本仓库链接后，Agent 应继续执行安全、可撤销的步骤，
无需让用户复制命令：

1. 确认当前主机、目标主机、操作系统和 CPU；安装用户级 Node.js 24，再安装 GitHub
   Releases 中最新的 `.tgz`。若目标是本仓库工作区，依次执行 `npm ci`、`npm run build`
   和 `npm install --global .`；不要把未构建的 GitHub 源码 URL 直接交给 npm。
2. 运行 `send-wechat status` 和 `send-wechat doctor`，根据结构化错误修复环境；未配置时
   运行 `setup`。二维码应写入一个新的 owner-only 临时文件并直接展示在对话中。
3. Cloudflare OAuth/账户选择、QR/验证码/首条入站消息、原生安全存储解锁等需要账户本人
   的步骤应暂停并给出一个明确动作；完成后继续，不把后续命令甩回给用户。
4. Hub 就绪后只问一次是否连接其他设备。若用户拒绝，结束设置且不生成邀请。
5. 用户同意且 Agent 已有 SSH 时，Agent 在远端安装 CLI，并通过 stdin 传送一次性邀请；
   POSIX 目标使用不捕获中间输出的直接管道
   `send-wechat setup --pair-stdout | ssh TARGET 'send-wechat setup --pair-stdin'`。邀请不得
   进入聊天、argv、shell history、普通日志或截图。没有 SSH 时，给目标设备上的 Agent
   一段不含长期凭据的交接说明。
6. 最后运行 `doctor` 与 `status`，只在确认目标设备可调用后报告完成。

Agent 不得索取或展示 Weixin 凭据、Cloudflare token、系统钥匙串内容、device key、邀请
全文或 IPC capability。系统密码只允许用户在操作系统的隐藏输入界面中填写。更新已配置
的安装需要用户另行授权；`reset` 也需要明确请求和交互确认。

## 公共命令

```text
send-wechat setup [--pair-stdin] [--qr-file PATH]
send-wechat send (--text TEXT | --stdin | --file PATH) [--idempotency-key KEY]
send-wechat status
send-wechat doctor
send-wechat reset
send-wechat service install|start|stop|restart|uninstall
```

`setup` 是唯一 onboarding 入口。首次 Hub 设置会完成 Cloudflare 授权与个人 Relay 部署、
安装服务、展示 QR，并等待绑定用户的第一条入站消息；bot 会自动回复一次“已连接”。
用户确认连接其他设备后，Agent 的受保护管道才会签发一个 10 分钟、单次使用的邀请，并
写入 `send-wechat setup --pair-stdin` 的 stdin；不支持把邀请放入命令参数。

Hub 和远端客户端共享同一套 CLI 与版本化 JSON 合约：

```sh
send-wechat send --text '一条消息'
send-wechat send --file ./report.pdf
printf '%s' '来自程序的消息' | send-wechat --json send --stdin
send-wechat --json status
send-wechat doctor
```

`accepted` 只表示 Weixin endpoint 接受，不表示 delivered 或 read。请求开始后缺少权威结果
时会返回 `RESULT_UNKNOWN`，工具不会自动重放；调用程序应保留同一个
`--idempotency-key`。退出码：`0` 成功，`2` 用法/输入错误，`3` 环境或会话未就绪，
`4` 发送结果/冲突/背压需调用方处理，`5` 本地内部失败。

## 平台与边界

- macOS arm64/x64、Windows x64/arm64、GNU/Linux glibc x64/arm64 可作为完整 Hub。
- WSL 与 headless GNU/Linux 是正式远端客户端：不运行 Weixin daemon、不显示 QR，也不需要
  Secret Service 或 systemd user service；它们只保存 owner-only 的本机设备凭据文件。
- GNU/Linux Hub 仍需要 Secret Service、systemd user manager 与 `XDG_RUNTIME_DIR`。
- Alpine/musl、32 位、FreeBSD 不在支持矩阵内。

一个 binding 只有一台 Hub。工具没有 `--to`、群发、多账户、GUI、MCP、公共 HTTP API、
公共库接口或 LAN listener。远端客户端只取得自己的 device key，永远不会取得 Weixin
token、context token 或其他设备的密钥。只有绑定用户的新入站消息能建立或续期 24 小时
会话；入站正文被忽略且不保存。

## 开发与安全资料

- 最终真实环境步骤：[`docs/manual-acceptance.md`](docs/manual-acceptance.md)
- 信任边界与漏洞报告：[`SECURITY.md`](SECURITY.md)
- 协议来源和许可证：[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- 领域与架构决策：[`CONTEXT.md`](CONTEXT.md)、[`docs/adr/`](docs/adr/)
