# ADR 0004: Upstream protocol and release support

Status: accepted

## Decision

Implement an independent iLink module by adapting only the required MIT-licensed
source behavior from Tencent `openclaw-weixin` tag `v2.4.6`, commit
`cef0bfc390393f716903e16d50408118047f87e0`. Preserve attribution in
`THIRD_PARTY_NOTICES.md`. Do not import OpenClaw, deep-import the Tencent package,
use a community fork at runtime, or download protocol code dynamically.

Unknown QR states, malformed responses, unknown state schemas, incompatible IPC
versions, and protocol changes fail closed. A scheduled GitHub workflow may
detect upstream changes and open an issue, but it never modifies or merges code.

The architecture targets macOS arm64/x64, Windows x64/arm64, and GNU/Linux
glibc x64/arm64. Linux requires a Secret Service provider, a systemd user
manager, and `XDG_RUNTIME_DIR`; Alpine/musl, non-systemd Linux, 32-bit systems,
FreeBSD, and mixed Windows/WSL operation are not supported.

An npm `0.x` preview requires a user-owned Cloudflare deployment, real QR,
inbound activation, local and remote text/file sends, invitation replay checks,
and Hub-offline behavior on representative installations. Version `1.0`
additionally requires macOS, Windows, and Linux background startup, reboot
recovery, expiry behavior, cloud-aware reset, uninstall, and truthful
support-matrix evidence. Real Cloudflare and Weixin operations remain manual
acceptance gates.

## Consequences

The project can evolve deliberately with upstream audits without inheriting an
OpenClaw runtime or pretending the iLink transport is a stable standalone SDK.
