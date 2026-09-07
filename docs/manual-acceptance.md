# Manual acceptance

> 状态：部分执行。2026-08-24 已在 macOS arm64 完成 Hub 安装、真实 Cloudflare
> deployment、Weixin QR、入站激活和文本发送；文件发送、真实远端配对、会话过期、
> reset，以及原生 Windows/GNU/Linux 验收仍待执行。自动验收不能代替这些外部效果。

## 证据规则

- 记录日期、平台/架构、Node 24 版本、tarball 名称和 `send-wechat --version`。
- 不保存 QR、OAuth code/token、邀请全文、device key、IPC capability、个人标识、消息正文
  或原始日志。邀请测试后让它过期或被消费。
- CLI 的 `accepted` 只记作 endpoint 接受；只有 Weixin 客户端实际看到内容时，才另记
  “人工确认收到”。
- 失败保持为失败/未执行；自动化结果不能代替真实平台、Cloudflare 或 Weixin 结果。

## 当前 Mac：首次 Hub 验收

从仓库根目录使用本地 tarball，不发布 npm：

```sh
npm run check
npm pack
ACCEPT_PREFIX="$(mktemp -d /tmp/send-wechat-acceptance.XXXXXX)"
npm install --global --prefix "$ACCEPT_PREFIX" ./send-wechat-0.1.0-rc.2.tgz
export PATH="$ACCEPT_PREFIX/bin:$PATH"
node --version
send-wechat --version
send-wechat setup
```

`setup` 会产生真实外部状态，请由仓库所有者亲自完成以下动作：

1. 浏览器打开 Cloudflare 设备授权页；确认授权的是预期 account。若有多个 account，确认
   CLI 显示选择并等待确认。
2. 若账户尚无 `workers.dev` 子域，确认 Wrangler 在当前终端交互询问名称与最终确认，
   不应自动选择 `no` 或要求重新执行另一条部署命令。随后在 Cloudflare dashboard
   确认只新增一个随机名 `send-wechat-*` Worker，使用
   `workers.dev`、一个 SQLite Durable Object，并且没有 custom domain/route。
3. 扫描 Weixin QR；若 Tencent 要求数字验证码，只输入 Tencent 展示的验证码。
4. 给新出现的 ClawBot 发一条非敏感消息；确认只收到一条“已连接”自动回复，`setup`
   随后完成且不生成设备邀请。再发一条消息续期时不应重复收到连接确认。
5. 运行 `send-wechat doctor` 与 `send-wechat --json status`，确认 Hub/Relay/凭据库/IPC
   正常且状态为 `ready`。
6. 分别执行文本、stdin、文件与同 key 去重测试；在 Weixin 客户端确认每项只收到一次：

```sh
send-wechat --json send --text 'send-wechat acceptance' --idempotency-key acceptance-text-v1
printf '%s' 'send-wechat stdin acceptance' | send-wechat --json send --stdin --idempotency-key acceptance-stdin-v1
send-wechat --json send --file ./non-sensitive-test-file.txt --idempotency-key acceptance-file-v1
send-wechat --json send --text 'send-wechat acceptance' --idempotency-key acceptance-text-v1
```

最后一条应报告本地去重，Weixin 不应再出现一份。

## 真实多设备验收

同一操作系统用户的角色不可变，所以不能只改 `$HOME` 来伪造第二台设备；系统钥匙串
仍会是同一个信任主体。请使用另一台电脑、VM，或本 Mac 的独立 macOS 用户账户。

1. Hub 使用无 shell trace 的直接管道运行
   `send-wechat setup --pair-stdout | ssh TARGET 'send-wechat setup --pair-stdin'`。证据、
   命令行和诊断记录中不得出现邀请全文。复制粘贴路径允许在用户选择的终端显示配对码。
2. Hub 和每台客户端/WSL 环境从同一 tarball 安装 CLI，并为各自 Agent 安装全局 skill。
   重开 Agent 会话验证技能发现，不发送消息。接收端执行
   `send-wechat setup --pair-stdin`；不应安装后台服务、创建 IPC capability、显示 QR、
   请求 Cloudflare OAuth，或把邀请写入 argv/history/log。
3. 远端运行 `doctor`、`status`、文本发送和一个大于 512 KiB 的非敏感文件发送；Hub
   与 Weixin 客户端确认文本/文件各一次，Cloudflare dashboard 不应出现 payload 存储。
4. 重放已消费邀请以及使用改动一个字符的邀请，均应失败且不能新增设备。
5. 停止 Hub 服务后从远端发送，必须很快返回 `HUB_OFFLINE`，不得排队；重启 Hub 后
   状态应自动恢复。
6. 重启 Hub 操作系统，确认当前用户服务与 outbound Relay 连接自动恢复；远端无需改配置。

## 发布阻断项：WSL Hub → macOS arm64 SSH 客户端

**状态：本次修复的真实双机用例待执行，发布前必须记录结果。** 自动化中的假 Relay、
模拟存储故障、macOS 本地文件测试均不能替代本项。使用独立 macOS 用户或测试机；不要
把现用 Hub 当客户端重置。无需把新的安装覆盖到日常使用环境来完成单元测试。

1. WSL Hub 保持已激活且在线；macOS 启用 Remote Login。记录两端 OS/CPU、Node 版本、
   tarball 哈希和 CLI 版本。两端使用同一待发布构建，分别验证全局 skill 可发现。
2. 在 WSL 先验证 `ssh USER@MAC 'send-wechat --version'`，再执行上述配对管道。
   接收端处于非 GUI SSH 会话；应完成配对，无 Keychain 提示。正常可达网络下记录总耗时；
   若超过 60 秒，记为失败并中断调查，不能把无限等待当作人工授权门槛。
3. 使用新的测试用户，把本地客户端状态目录设置成不可写或不安全权限（仅操作测试目录），
   再输入一份有效邀请。要求在 5 秒内报告本地存储/权限层失败，Hub 未新增设备，本机无有效
   客户端安装。修复测试目录后，在十分钟有效期内使用同一份邀请应成功。
4. 检查凭据目录/文件权限分别为 `0700`/`0600`，不读取或记录内容。运行 `doctor` 和
   `status`，然后另行执行已授权的文本/文件测试，分别记录接口接受和人工收到。
5. 再用独立客户端测试人工复制路径：Hub `setup --pair-stdout` → 客户端 `setup --pair` →
   粘贴一整行并回车。应立即结束输入，无需 Ctrl-D；参数和诊断输出不含配对码。
6. 在测试客户端构造缺失凭据/安装记录、残留服务配置，确认 `doctor` 报具体本地层；
   `reset --local` 确认后可清理并重新配对，Cloudflare 部署与 Hub 保持正常。对已识别的 Hub
   调用 `reset --local` 必须拒绝且不修改绑定。
7. 单独记录进程崩溃、网络最终响应丢失的结果：本流程可留下待诊断状态，允许本地恢复后用
   新邀请配对。它不承诺分布式崩溃原子性，不能把此项误记为存储故障重试已验证。

验收记录至少包含：构建哈希、场景、是否 SSH/GUI、耗时、错误码、两端诊断结果、skill
发现情况。只记录脱敏元数据；不要记录配对码、凭据和微信正文。

## 会话、reset 与失败边界

1. 在真实窗口观察第 22 小时后的 `renewal_due`；不回复直到 24 小时后，发送应 fail
   closed。绑定用户再发一条入站消息后恢复 `ready`。
2. 远端执行 `reset`：确认只清除该设备本机状态，不删除 Worker、不停止 Hub。该操作
   不撤销 Hub 端授权；已复制到别处的旧 device key 仍需通过 Hub 整体 reset 才失效。
3. Hub 执行 `reset` 前先测试取消，取消不得改变状态。正式输入 `RESET` 后确认 Worker
   和 Durable Object 从记录的 Cloudflare account 删除，服务停止，本机绑定/状态清除。
4. 如 Cloudflare 删除人为失败（例如断网），确认 reset 返回失败且保留 Hub 本地管理状态；
   网络恢复后重试成功。

## Windows 与 GNU/Linux

在 Windows x64/arm64、GNU/Linux glibc x64/arm64 各重复“首次 Hub”或“真实多设备”
流程至少一次，并验证 Hub 当前用户服务的安装、重启和开机恢复。GNU/Linux Hub 同时
确认 Secret Service provider、systemd user manager 与 `XDG_RUNTIME_DIR`。WSL 与
headless GNU/Linux 只执行远端客户端流程，确认没有 Secret Service、systemd user service
或图形会话时仍可配对、status、doctor、发送与 reset。Alpine/musl、32 位和 FreeBSD
不进入支持矩阵。

| 平台/角色                        | setup/OAuth/QR | Relay/重连 | 文本/文件/去重 | 22h/24h | reset | 日期与脱敏证据 |
| -------------------------------- | -------------- | ---------- | -------------- | ------- | ----- | -------------- |
| macOS Hub                        | [ ]            | [ ]        | [ ]            | [ ]     | [ ]   |                |
| 独立 macOS 用户或第二设备 Client | [ ]            | [ ]        | [ ]            | N/A     | [ ]   |                |
| Windows Hub/Client               | [ ]            | [ ]        | [ ]            | [ ]     | [ ]   |                |
| GNU/Linux glibc Hub              | [ ]            | [ ]        | [ ]            | [ ]     | [ ]   |                |
| WSL/headless GNU/Linux Client    | N/A            | [ ]        | [ ]            | N/A     | [ ]   |                |
