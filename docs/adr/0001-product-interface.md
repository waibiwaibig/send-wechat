# ADR 0001: Product and command interface

Status: accepted

## Decision

Ship one public npm package and executable named `send-wechat`, requiring
Node.js 24 LTS. The public commands are:

```text
send-wechat setup [--pair INVITATION] [--qr-file PATH]
send-wechat send (--text TEXT | --stdin | --file PATH) [--idempotency-key KEY]
send-wechat status
send-wechat doctor
send-wechat reset
send-wechat service install|start|stop|restart|uninstall
```

Global `--json` emits one schema-versioned JSON result and global `--lang`
selects `zh-CN` or `en`. Programs should prefer stdin over command arguments for
message content. A send result uses the word `accepted`, never `delivered`.

`setup` is the only onboarding interface. With no existing role and no pairing
invitation, it provisions a personal relay in the user's own Cloudflare
account, installs and starts the local Hub daemon, performs QR login, and waits
for the first inbound owner message. On an existing Hub it creates a
short-lived, single-use invitation. With `--pair`, it configures the machine as
a remote client of that Hub. The removed `login` command has no compatibility
alias.

There is no recipient option, shorthand send command, GUI, MCP interface,
project-operated relay, public library interface, router configuration, or LAN
listener. The user-owned relay transport is an internal interface and does not
turn the CLI into a general Weixin HTTP endpoint.

## Consequences

Programs receive the same stable JSON and exit-code contracts on a Hub or a
paired remote client without acquiring Weixin credentials or daemon internals.
Interactive Cloudflare authorization, QR login, and device pairing remain
explicit setup actions. Product scope cannot silently expand into a general
Weixin automation surface.
