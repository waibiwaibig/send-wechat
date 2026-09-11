# send-wechat

让 Codex、Claude Code 或其他终端 Agent 把文字、文件发到你自己的微信，也可以启用
微信秘书，直接在微信里与固定的 Codex 会话对话。告诉 Agent：

> 请安装并设置 https://github.com/waibiwaibig/send-wechat，并在每台设备上为我使用的
> Agent 安装用户级全局 send-wechat skill。已有 Hub 就连接它；检查 skill、doctor 和 status。
> 基础配置完成后，问我是否要启用微信秘书；我同意后再继续配置。

只需要一台常在线的 **Hub** 扫码绑定微信。其他电脑作为客户端，通过你的个人 Cloudflare
Relay 使用同一个绑定。Hub 负责微信连接；客户端不需要扫码、Cloudflare 账户或后台服务。
项目非官方，项目方不运营公共 Relay。

## 安装与全局 skill

Agent 安装 Node.js 24+ 和 [GitHub Release](https://github.com/waibiwaibig/send-wechat/releases)
中的 `.tgz`，然后复制包内 `.agents/skills/send-wechat/` **整个目录**到 Agent 的用户级目录：

| Agent                                                 | 用户级全局目录                      |
| ----------------------------------------------------- | ----------------------------------- |
| Codex                                                 | `$HOME/.agents/skills/send-wechat/` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `$HOME/.claude/skills/send-wechat/` |
| 其他 Agent                                            | 按该 Agent 的官方用户级 skills 路径 |

**Hub、每台客户端、WSL 内部都要分别安装 CLI 和全局 skill。** 一台设备使用多个 Agent，
就给每个 Agent 安装。只装 npm 包不会注册 skill；只放仓库里也不能保证其他项目能发现。
安装后重开 Agent 会话，检查是否发现 `send-wechat`，无需发消息测试。

Agent 的安装步骤、复制命令和排障见 [setup.md](.agents/skills/send-wechat/setup.md)。
从源码安装先运行 `npm ci`、`npm run build`、`npm install --global .`。
预发布阶段从 Releases 列表选择带 `.tgz` 安装包的最新版本；`releases/latest` 不包含预发布。

## 第一台设备

运行 `send-wechat setup`。Agent 负责部署 Relay、安装服务和诊断；你完成 Cloudflare
浏览器授权、扫码，并给新出现的 bot 发一条消息。看到“已连接”后检查：

```sh
send-wechat doctor
send-wechat --json status
```

`status` 为 `ready` 才能发送。Hub 需要保持在线；微信会话到期时，再给 bot 发一条消息续期。

## 连接其他设备

先在两端装好 CLI 和各自 Agent 的全局 skill。以下任选一种：

**SSH：** 在 Hub 执行，`TARGET` 换成可登录的客户端：

```sh
send-wechat setup --pair-stdout | ssh TARGET 'send-wechat setup --pair-stdin'
```

也可以在客户端执行 `ssh HUB 'send-wechat setup --pair-stdout' | send-wechat setup --pair-stdin`。
SSH 远端 shell 必须能找到 `send-wechat`；Agent 先检查 `ssh TARGET 'send-wechat --version'`。

**复制粘贴：** 在 Hub 终端运行 `send-wechat setup --pair-stdout`，复制输出的一整行配对码。
在客户端终端运行 `send-wechat setup --pair`，粘贴配对码并回车。配对码十分钟内有效、
只能连接一台设备；可以由你通过自己的私聊传给另一端，再粘贴到终端提示中。

配对后在客户端运行 `doctor` 和 `status`。macOS、Linux、WSL 客户端使用当前用户专用
的设备凭据文件，SSH 中无需 Keychain 或 Secret Service 弹窗。Windows 客户端使用原生凭据库。

## 发送与恢复

```sh
send-wechat send --text '一条消息'
send-wechat send --file ./report.pdf
printf '%s' '来自程序的消息' | send-wechat --json send --stdin
send-wechat doctor
send-wechat reset --local
```

`reset --local` 用于清理客户端本机配对与残留服务，然后重新配对；它拒绝用于已识别的 Hub，
不会删除云端 Relay。清理前会要求输入 `RESET`。旧版 macOS 客户端升级后需要本地重置并重新配对。
Hub 的完整 `reset` 会删除云端部署和本机绑定，请仅在需要重建 Hub 时使用。

具体文字或文件就是本次发送授权。`accepted` 表示微信接口接受；收到与已读需要另外确认。
`RESULT_UNKNOWN` 表示结果未知，Agent 不得自动重发。工具始终只发给扫码绑定的用户，
没有收件人选项、群发或多账户。程序调用用全局 `--json`；退出码为 0 成功、2 输入错误、
3 环境/会话未就绪、4 发送结果需处理、5 本地失败。

## 用微信与 Codex 对话

可选的 `send-wechat-gateway` 是独立后台进程，把你的微信文字交给固定的 Codex CLI
会话，并把回答逐段发回微信。它不依赖 Codex 桌面应用，也不管理其他工作会话。
同一个安装包提供发送工具和秘书桥，秘书服务按需启用。Agent 完成基础配置后会询问
是否启用；同意后，它在现有 Hub 上检查 Codex、引导登录、确定工作目录并启动服务。
以后也可以直接告诉 Agent：“帮我启用 send-wechat 微信秘书。”

Agent 的完整流程见 [秘书配置指南](.agents/skills/send-wechat/gateway.md)。自行配置时，
在已经绑定微信、安装并登录 Codex CLI 的 Hub 上运行，`--cwd` 使用你选择的工作目录：

```sh
send-wechat-gateway setup --cwd /absolute/chosen/directory
send-wechat-gateway --json status
```

之后直接给绑定的 bot 发文字即可。每个新会话首轮会加载极短的微信连接 skill。
发送 `/` 查看命令，`/model astra low` 选择模型和推理强度。秘书默认完全访问；
发送 `/permission` 查看模式，用 `/permission workspace` 或 `/permission read-only`
限制后续执行。`/stream off` 关闭逐段发送，`/stream on` 开启，下一次回复生效。
单独发送 `/recover` 可续期微信发送会话，由 Hub 处理，不触发或打断 Codex。
会话按最后一次有效入站消息滚动计时 24 小时，第 23 小时起尝试提醒一次；
轮询延迟、断网或发送队列繁忙可能导致提醒延后或未发出。
普通新消息会打断当前回复；`/newchat` 切换到空白聊天上下文，同时提醒
保留的模型、权限与流式状态。关闭 gateway 不影响普通的 `send-wechat send` 文本和文件发送。
安装新版包后先重启 Hub 服务，使它加载入站接口。配置、服务控制和验收边界见
[gateway 使用说明](docs/gateway.md)。

## 支持与验证

macOS、Windows、GNU/Linux glibc 的 arm64/x64 在支持范围内。Linux Hub 需要 Secret Service、
systemd user manager 和 `XDG_RUNTIME_DIR`；WSL/headless Linux 推荐作为客户端。
客户端凭据文件由操作系统用户权限保护；消息和文件经过 Relay 时端到端加密，Relay 不持久化正文。

当前为预发布版本。自动测试、真实 SSH 配对和微信实收各有独立验收记录，详见
[人工验收](docs/manual-acceptance.md)。开发资料：[安全边界](SECURITY.md)、
[领域与架构](CONTEXT.md)、[协议来源](THIRD_PARTY_NOTICES.md)。
