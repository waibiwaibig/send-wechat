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
完成 Codex 登录。gateway 使用这个用户已有的 Codex 配置、模型及权限设置。
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
日志不会转发。

新文字到来时，gateway 请求中止当前 Codex turn，收到结束事件后提交新输入。
同一批收到的连续普通文字按原顺序合并，`/newchat` 是明确的分界。
已经执行的操作和已经提交给微信接口的消息无法通过打断撤销。尚未提交的旧回复
片段会被丢弃。

发送单独一行 `/newchat` 会停止当前回复，清空当前会话绑定，下一条文字到来时创建
新的会话。即使切换后马上重启，下一条文字仍使用空白上下文。旧聊天内容不会
传入新会话，Codex 的系统设定、配置和工具仍然适用。旧会话保留在 Codex 自己的
历史中，gateway 不提供会话列表或回切功能。旧会话后续事件不会进入新对话。

gateway 不代替用户批准 Codex 的权限请求，也不提高 Codex 的执行权限。需要客户端
审批或表单交互的请求会被拒绝，并通过文字说明；该类操作需要在支持相应交互的
Codex 客户端中完成。

## 流式发送

Codex 的输出通过 App Server 事件持续进入 gateway。gateway 合并短片段，按句子、
段落和长度切分；短回复也会按定时器及时发出。每次只有一个片段提交给 Hub，避免
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

自动测试覆盖协议握手、流式事件、打断与切换、入站去重、服务隔离和故障处理。
另提供真实 Codex CLI 的可选协议测试，使用临时配置目录和本机模拟 Responses 服务，
验证流式输出、turn 完成及进程重启后恢复会话，不使用真实模型账户：

```sh
CODEX_SMOKE_BINARY="$(command -v codex)" npx vitest run tests/gateway-real-codex.test.ts --maxWorkers=1
```

2026-09-08 已用 Codex CLI 0.152.1 通过该测试。真实 CLI 的中断行为、真实模型生成、
微信实收、手机端流式展示及各平台的登录后自动运行，仍需在目标环境分别验收。
测试通过不等同于微信消息已送达。

参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、
[Tencent 流式声明](https://github.com/Tencent/openclaw-weixin/blob/7c04adc3e95775efd661ab9fba0626d86d237713/src/channel.ts#L229-L239)。
