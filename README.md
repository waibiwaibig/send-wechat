# send-message

让 Codex、Claude Code 或其他终端 Agent，把文字、图片和文件发到微信或飞书。
安装时选择微信、飞书，或两者都装；双渠道安装再选择默认渠道。直接把仓库交给 AI：

> 请安装并设置 https://github.com/waibiwaibig/send-wechat。
> 先问我要装微信、飞书还是两者，再确定默认渠道和是否需要多设备。
> 在每台设备上安装统一的全局 send-message skill。
> 基础发送验证后，分别问我是否启用 Codex 任务通知和 Codex 秘书。

项目非官方，项目方不运营公共消息服务。GitHub 仓库地址暂保留原名。

## 安装

需要 Node.js 24+。当前源码版本使用新的产品入口，从源码安装：

```sh
npm ci
npm run build
npm install --global .
```

把 `.agents/skills/send-message/` **整个目录**复制到每个 Agent 的用户级 skill 目录。
Codex 可使用 `~/.agents/skills/send-message/`，Claude Code 使用
`~/.claude/skills/send-message/`。Hub、客户端、WSL 分别安装，并在新 Agent 会话中确认发现。
旧 `send-wechat` 发布包不包含本版接口；本版没有旧命令别名或状态迁移。

完整安装步骤见 [统一 skill](.agents/skills/send-message/SKILL.md) 和
[安装指南](.agents/skills/send-message/setup.md)。

## 选择渠道

| 渠道 | 接入方式       | 固定目标               | 主要限制                                 |
| ---- | -------------- | ---------------------- | ---------------------------------------- |
| 微信 | 扫码绑定 iLink | 扫码绑定的用户         | 入站上下文、会话时限及上游主动消息限制   |
| 飞书 | 自建应用机器人 | 自己的私聊或指定通知群 | 应用权限、发布范围、群成员资格、API 配额 |

微信：`send-message setup --channels wechat`。扫码后给 bot 发第一条消息。
飞书：`send-message setup --channels feishu --feishu-config-stdin`。
双渠道使用 `--channels both --default-channel wechat|feishu`。
飞书应用配置通过标准输入传入，字段和权限见 [飞书指南](.agents/skills/send-message/feishu.md)。
已有自定义 Webhook 需要改为应用机器人，才能使用本工具的文件发送和双向秘书能力。

单台电脑直接使用本地服务，不需要 Cloudflare。多台电脑共用一个常在线 Hub 时，
显式运行 `send-message setup --relay`，授权部署个人 Cloudflare Relay，再配对客户端：

```sh
send-message setup --pair-stdout | ssh TARGET 'send-message setup --pair-stdin'
```

凭据只保存在 Hub；客户端保存自己的设备密钥。Hub 离线时发送失败。

## 发送与结果

```sh
send-message send --text '一条消息'
send-message send --channel feishu --image ./plot.png
send-message send --channel wechat --file ./report.pdf
send-message --json send --channel both --text '明确要求双发的通知'
send-message --json status
send-message doctor
```

省略渠道时使用已配置的默认渠道。只有显式 `both` 才会双发。每个渠道单独报告结果；
一边成功、一边失败时保留部分成功信息。发送失败不会自动切换渠道。
`accepted` 表示接口接受，实际收到和设备提醒需要另行确认。未知结果不自动重发；
使用 `--idempotency-key` 可防止同一操作被重复提交。

微信与飞书分别维护限制、凭据和账本。[微信指南](.agents/skills/send-message/wechat.md)
解释会话续期及 `/recover`；飞书按应用 API 的权限和配额处理。

## 可选 Codex 功能

**任务通知**：用户选择启用后，`send-message notifications --enable` 安装 Codex hooks。
只通知根任务回合结束和等待回答，不包含子智能体。可使用默认渠道或显式指定渠道。
写入配置后需要在 Codex 中信任新 hook，详见
[通知指南](.agents/skills/send-message/notifications.md)。

**秘书**：在 Hub 上安装并登录 Codex CLI，明确工作目录和权限后：

```sh
send-message-gateway --channel wechat setup --cwd /absolute/workspace --permission workspace
send-message-gateway --channel feishu setup --cwd /absolute/workspace --permission workspace
send-message-gateway --channel feishu --json status
```

两端各自使用独立会话，接收文字、图片和文件，回复回到原渠道。
默认权限限定在工作区；完整权限需明确选择。飞书群只接受安装者的指令。
详见 [秘书指南](.agents/skills/send-message/gateway.md)。

## 开发与验证

`npm run check` 执行类型、风格、覆盖率及 Relay 测试，`npm run build` 验证发布产物。
协议测试使用模拟上游；真实账号登录、权限、文件收发、设备提醒和秘书回程需单独验收。
架构见 [CONTEXT.md](CONTEXT.md) 与 [ADR 0009](docs/adr/0009-unified-messaging.md)。
