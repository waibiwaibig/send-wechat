# 微信与 Codex CLI 对话

`send-wechat-gateway` 把绑定用户的微信文字转发给一个固定的 Codex CLI 会话，
并将回答逐段发回微信。gateway 自身不运行模型。会话历史、工具和实际执行工作
由 Codex 负责；gateway 保存当前会话 ID 和转发所需的少量状态。

## 启用

可以直接让安装 Agent 完成配置：“基础微信发送配置好后，问我是否要启用微信秘书。”
Agent 会先确认基础收发可用，再询问一次；同意后按包内的
[秘书配置指南](../.agents/skills/send-wechat/gateway.md) 在现有 Hub 上继续。
选择暂不启用时，基础发送照常可用；以后可以再让 Agent 帮你启用。

在微信 Hub 上安装 Node.js 24+、本项目和 Codex CLI，并在同一个操作系统用户下
完成 Codex 登录。gateway 使用这个用户已有的 Codex 登录与默认模型。秘书默认采用完全访问模式，可在微信中切换权限。
`--cwd` 决定 Codex 的工作目录及其适用的项目指令。

从源码安装本次功能：

```sh
npm ci
npm run build
npm install --global .
send-wechat service restart
send-wechat-gateway setup --cwd /absolute/chosen/directory
send-wechat-gateway --json status
```

`setup` 保存配置，并安装、启动独立的 gateway 后台服务。它使用现有 Hub，不重新
扫码、不新建 Relay、不读取微信登录凭据。gateway 当前运行在 Hub 本机；远程客户端
继续保留普通发送功能。

`--cwd` 替换成你选定的绝对路径；路径含空格时加引号。没有现成工作目录时，可以
创建专用的 `~/wechat-secretary`。安装包包含 gateway 命令是启用前提；旧发行包需要
更新到实际包含该命令的版本，源码目录中的新功能并不代表发行包已经包含它。

`setup` 会记录 Codex 可执行文件的绝对路径和当前 PATH，供后台服务使用。可以通过
`--codex /absolute/path/to/codex` 指定可执行文件。Windows 使用原生 `codex.exe`；
`.cmd` 和 `.bat` 包装脚本不作为可执行入口。更换安装路径或工作目录前先停止 gateway，
然后重新运行 `setup`。这一操作保留当前会话，空白会话由 `/newchat` 明确创建。

退出 Codex 桌面应用不影响 gateway。后台服务由 macOS LaunchAgent、Linux systemd
用户服务或 Windows 用户计划任务管理，沿用对应平台的登录和后台运行条件。
电脑关机、休眠或网络中断会影响通信。

## 在微信里使用

普通文字进入当前会话。第一次收到文字时创建会话；以后沿用同一个会话，gateway
重启后也使用已保存的会话 ID。Codex 生成的可见回复逐段回传，内部推理和原始工具
日志不会转发。每个新会话的首轮通过 Codex 原生 skill 输入单独加载包内的
`wechat-connection`，说明微信 → Hub → gateway → Codex CLI 的连接关系；
后续轮次和重启恢复已有会话时不重复注入，用户正文保持原样。
gateway 为自己的 Codex 进程注册包内 skill 目录，独立工作目录也能加载；
用户工作目录和全局 Codex 配置无需复制或安装这份 skill。

新文字到来时，gateway 请求中止当前 Codex turn，收到结束事件后提交新输入。
同一批收到的连续普通文字按原顺序合并，独立发送的斜杠命令是明确的分界。
已经执行的操作和已经提交给微信接口的消息无法通过打断撤销。尚未提交的旧回复
片段会被丢弃。

发送单独一行 `/newchat` 会停止当前回复，清空当前会话绑定，下一条文字到来时创建
新的会话。即使切换后马上重启，下一条文字仍使用空白上下文。旧聊天内容不会
传入新会话，Codex 的系统设定、配置和工具仍然适用。旧会话保留在 Codex 自己的
历史中，gateway 不提供会话列表或回切功能。旧会话后续事件不会进入新对话。

发送 `/` 或 `/help` 查看命令。微信输入框没有本服务可注册的原生命令补全；菜单在
消息发送后返回。全角 `／` 也可使用。未知命令返回帮助，不交给模型猜测执行。

| 命令                    | 行为                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `/recover`              | 续期微信发送会话，由 Hub 处理，不触发或打断 Codex          |
| `/model`                | 显示当前模型、实时可选型号和各自支持的推理强度             |
| `/model astra low`      | 选择模型及强度，下一次回复生效                             |
| `/permission`           | 显示当前权限和可用模式                                     |
| `/permission full`      | 完全访问（默认），允许本机文件读写和网络访问               |
| `/permission workspace` | 工作区写入，网络受 Codex 沙箱限制                          |
| `/permission read-only` | 只读，网络受 Codex 沙箱限制                                |
| `/stream`               | 查看流式发送状态与开关用法                                 |
| `/stream on`            | 开启逐段发送，下一次回复生效                               |
| `/stream off`           | 等每条完整回复生成后再发送，下一次回复生效                 |
| `/newchat`              | 清空聊天上下文，并提醒保留的模型、推理强度、权限和流式状态 |

模型选择以 Codex 的 `model/list` 为准；可用唯一简称或完整模型名，省略强度时使用
该模型默认值。选择只保存到秘书状态，重启后继续生效。模型目录可用不保证账户
具有实际推理权限，执行失败会显示错误。查看菜单和选择模型会保留当前回复；
权限切换会先中止当前执行，确认结束后保存新模式，后续输入使用新权限。

例如，先单独发送 `/model` 查看当前目录，再发送 `/model astra low` 选择 Astra
与 low 推理强度，随后发送普通问题即可使用该设置。`/model astra` 使用目录里标明的
默认强度；`/model gpt-6-astra low` 使用完整模型名。示例中的模型和强度需出现在
当前目录中，输入无效时会返回说明并保留原设置。

秘书通过会话与轮次参数设置权限，不修改全局 Codex 配置。三种模式都关闭交互审批；
受限制的操作直接失败。额外的审批或表单请求会被拒绝，并通过文字说明。
完全访问允许秘书执行本机命令和修改工作目录之外的文件，执行范围由用户请求决定。
已经执行或交给后台进程的操作不会因权限切换而撤销。

## 流式发送

发送 `/stream` 查看当前设置，`/stream on` 开启，`/stream off` 关闭。默认开启；
选择在重启与 `/newchat` 后保留。开关从下一次回复生效，正在生成的回复继续沿用
开始时的设置，切换本身不会打断回复。

关闭时，每条可见的 Codex 消息完成后才发送，4000 字符以内保持一条微信消息；
超长内容按微信单条长度限制切分。进度说明和最终答案各自完成时仍会分别发出。

开启时，Codex 的输出通过 App Server 事件持续进入 gateway。gateway 合并短片段，按句子、
段落和长度切分。默认合并窗口为三秒，定时器仅发送已完整的句段；未完成的尾句
等待后续内容或消息完成，完整短回复在完成事件到达时立即提交。超过长度上限的内容
仍需切分。每次只有一个片段提交给 Hub，避免
整篇回复占满基础发送队列。已有 Hub 的串行发送、两秒发送间隔和单条长度限制继续
生效。

这一方式对应 Tencent 插件已实现的 block streaming，会产生多条微信消息。
源码中的 `GENERATING` 类型声明尚不足以证明同一微信气泡可以逐字更新，当前实现
不依赖未经验证的更新语义。

## 服务与状态

```sh
send-wechat-gateway --json status
send-wechat-gateway service stop
send-wechat-gateway service start
send-wechat-gateway service restart
send-wechat-gateway service uninstall
```

这些命令只操作 gateway 服务。`status` 中的 `responsive` 由近期心跳判断，
`threadId` 是当前会话，`lastError` 是最近的错误代码。前台诊断可在停止后台服务后
运行 `send-wechat-gateway run`。同一时刻只允许一个 gateway 消费入站文字。

配置、当前会话和运行状态位于 Hub 状态目录下的 `gateway/`，与微信绑定和普通
发送记录分开。文本收件箱位于 Hub 的 `text-inbox.sqlite`，使用操作系统用户专用
权限；gateway 活跃订阅期间才收集正文。尚未确认的文本最多保留 24 小时、500 条，
缓冲溢出会出现在 gateway 状态中。停止 gateway 后，新消息仍可续期微信会话，
正文不再作为待执行指令积累。

连接中断后，已经开始向 Codex 提交、但未能确认结果的输入不会自动重放。
gateway 会保留错误状态，在收到后续文字时说明这一情况。微信发送结果未知也不会
自动重发。需要核对的结果应检查对应 Codex 会话和微信实收。

## 验证范围

自动测试覆盖协议握手、首轮 skill、模型目录与参数、权限映射、命令隔离、
流式分段与开关、回合中切换及重启保留、打断、入站去重、服务隔离和故障处理。
另提供真实 Codex CLI 的可选协议测试，使用临时配置目录和本机模拟 Responses 服务，
验证流式输出、turn 完成及进程重启后恢复会话，不使用真实模型账户：

```sh
CODEX_SMOKE_BINARY="$(command -v codex)" npx vitest run tests/gateway-real-codex.test.ts --maxWorkers=1
```

2026-09-08 已用 Codex CLI 0.152.1 在独立空工作目录通过该测试，确认模型、推理强度
及首轮 skill 正文进入模拟模型请求。npm 安装包解压后的 adapter 也通过同样的
独立目录加载检查。本地 macOS 的 364 项单元测试、4 项 Relay 测试、覆盖率门槛、类型检查、
代码检查和构建均通过；未部署远端 Hub。真实 CLI 的中断行为、真实模型生成、
微信实收、手机端流式展示及各平台的登录后自动运行，仍需在目标环境分别验收。
测试通过不等同于微信消息已送达。

参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、
[Tencent 流式声明](https://github.com/Tencent/openclaw-weixin/blob/7c04adc3e95775efd661ab9fba0626d86d237713/src/channel.ts#L229-L239)。
