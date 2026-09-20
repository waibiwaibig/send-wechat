# ADR 0001: Product and command interface

Current product scope: [ADR 0009](0009-unified-messaging.md) supersedes the WeChat-only interface, mandatory Relay, text-only secretary, and full-access default described below.
Status: accepted

## Decision

Ship one public npm package and executable named `send-message`, requiring
Node.js 24 LTS. The public commands are:

```text
send-message setup [--pair-stdin] [--qr-file PATH]
send-message send (--text TEXT | --stdin | --file PATH) [--idempotency-key KEY]
send-message status
send-message doctor
send-message reset
send-message service install|start|stop|restart|uninstall
```

Global `--json` emits one schema-versioned JSON result and global `--lang`
selects `zh-CN` or `en`. Programs should prefer stdin over command arguments for
message content. A send result uses the word `accepted`, never `delivered`.

`setup` is the only CLI onboarding interface. The public onboarding experience
is Agent-first: an explicit request to install or set up the GitHub repository
authorizes an Agent to perform safe, user-scoped installation, diagnostics,
and configuration. The Agent pauses for Cloudflare account authorization, QR
or verification, native secret entry, and the decision to connect more
devices. With no existing role and no pairing invitation, `setup` provisions a
personal relay in the user's own Cloudflare
account, installs and starts the local Hub daemon, performs QR login, and waits
for the first inbound owner message. A fresh Hub setup returns ready without
creating an invitation. On an existing Hub, an internal raw-output mode creates
a short-lived, single-use invitation only after the user chooses to connect
another device and streams it directly to the new device. `--pair-stdin`
configures that remote client without placing the invitation in argv, shell
history, or copied commands. The removed `login` and `--pair` interfaces have
no compatibility aliases.

There is no recipient option, shorthand send command, GUI, MCP interface,
project-operated relay, public library interface, router configuration, or LAN
listener. The user-owned relay transport is an internal interface and does not
turn the CLI into a general Weixin HTTP endpoint.

ADR 0007 adds the optional `send-message-gateway` executable. It has its own
configuration and background service and consumes a generic authenticated local
text inbox. The existing `send-message` command set remains independent of Codex.

## Consequences

Programs receive the same stable JSON and exit-code contracts on a Hub or a
paired remote client without acquiring Weixin credentials or daemon internals.
Interactive Cloudflare authorization, QR login, and device pairing remain
explicit setup actions. Routine installation and recovery stay with the Agent.
Product scope cannot silently expand into a general Weixin automation surface.
