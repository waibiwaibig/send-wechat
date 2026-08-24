# Third-party notices

本文件记录当前仓库可以由 `docs/adr/0004-upstream-and-release.md` 和
`package-lock.json` 核验的来源与直接依赖信息。它不复制第三方项目的大段许可证或版权正文；发布和使用时仍须遵守每个依赖包随附的许可证和 notice。

## Tencent iLink 上游来源

项目独立实现 iLink 模块时，仅适配 Tencent `openclaw-weixin` 的必要 MIT-licensed
source behavior，来源固定为：

- tag：`v2.4.6`
- commit：`cef0bfc390393f716903e16d50408118047f87e0`
- repository：<https://github.com/Tencent/openclaw-weixin>
- 用途：为本项目的独立 iLink 模块提供所需协议行为的来源和 attribution

`send-wechat` 不在运行时导入 OpenClaw，不 deep-import Tencent package，不使用 community fork，也不动态下载协议代码。上游协议来源不是本项目的运行时 npm 依赖。

Tencent 上游许可证 notice：

> Copyright (C) 2026 Tencent. All rights reserved.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## 直接运行时依赖

以下版本和许可证字段来自当前 `package-lock.json`：

| Package                     | Locked version | License           |
| --------------------------- | -------------: | ----------------- |
| `@napi-rs/keyring`          |        `1.3.0` | MIT               |
| `@vscode/os-proxy-resolver` |        `0.3.0` | MIT               |
| `commander`                 |       `15.0.0` | MIT               |
| `file-type`                 |       `22.0.2` | MIT               |
| `qrcode`                    |        `1.5.4` | MIT               |
| `proxy-agent`               |        `8.0.2` | MIT               |
| `undici`                    |       `8.10.0` | MIT               |
| `wrangler`                  |      `4.125.0` | MIT OR Apache-2.0 |
| `ws`                        |       `8.21.3` | MIT               |
| `zod`                       |        `4.4.3` | MIT               |

## 直接开发与验证依赖

这些依赖用于构建、类型检查、lint、测试和覆盖率验证，不属于运行时功能面：

| Package                     | Locked version | License           |
| --------------------------- | -------------: | ----------------- |
| `@types/node`               |      `24.13.3` | MIT               |
| `@types/qrcode`             |        `1.5.6` | MIT               |
| `@types/ws`                 |       `8.18.1` | MIT               |
| `@cloudflare/vitest-plugin` |        `1.0.0` | MIT               |
| `@cloudflare/workers-types` | `5.20260823.1` | MIT OR Apache-2.0 |
| `@vitest/coverage-v8`       |       `4.1.11` | MIT               |
| `eslint`                    |       `10.9.0` | MIT               |
| `prettier`                  |        `3.9.6` | MIT               |
| `typescript`                |        `6.0.3` | Apache-2.0        |
| `typescript-eslint`         |       `8.67.0` | MIT               |
| `vitest`                    |       `4.1.11` | MIT               |

锁文件还包含这些直接依赖的传递依赖；它们各自的版本、许可证和随包 notice 以锁文件及 npm 安装结果为准。这里不重新复制传递依赖的版权文本。
