# send-message

send-message is an Agent-first command-line tool for delivering text, images, and
files through WeChat and Feishu. One Hub owns the configured provider credentials
and fixed recipients. Each user chooses WeChat, Feishu, or both during installation;
a dual-channel installation has one explicit default.

## Domain vocabulary

- **Channel**: `wechat` or `feishu`, with independent credentials, limits, inbox,
  idempotency ledger, and secretary conversation.
- **Selection**: one channel, or explicit `both`. An omitted selector uses the Hub's
  default channel. Failure never changes selection.
- **Local Hub**: single-machine installation, with an owner-only local IPC endpoint.
  It needs no Cloudflare account or public address.
- **Relay Hub**: the same provider-owning machine with an optional personal Cloudflare
  Relay for paired remote clients. The Hub stays online.
- **Client**: a paired device with its own Relay credential, without provider secrets.
- **Secretary**: a separately enabled channel-specific Codex CLI conversation. Incoming
  owner text/images/files enter that conversation and replies use that channel.
- **Accepted**: the provider acknowledged the request. Device receipt/read state is
  not inferred. Unknown results remain terminal until human investigation.

## Product boundaries

`send-message` and the complete `.agents/skills/send-message` directory are the public
sending and Agent installation entry points. The optional `send-message-gateway` runs
secretary services. The old command and skill names have no compatibility aliases.
GitHub hosting remains at `waibiwaibig/send-wechat` until separately renamed.

Each channel has one fixed target. WeChat binds by QR to one user. Feishu uses a
self-built application and targets the installer's DM or one notification group.
Feishu group commands require both the bound owner open_id and configured chat_id.
No arbitrary per-send recipients, automatic channel failover, or implicit dual sending.

The unified result retains a response per selected channel, including partial success.
Channels have separate persistent ledgers. Reusing a key with different content fails;
a completed accepted send is not repeated, and pending/unknown sends are not retried.

## Provider boundaries

WeChat protocol behavior is pinned to Tencent openclaw-weixin v2.4.6 commit
`cef0bfc390393f716903e16d50408118047f87e0`. Fresh inbound context enables active sending;
the local reminder is due at 23 hours and sending blocks at 24 hours. `/recover` is
handled by the Hub. Upstream rejection can still occur during a locally valid session.
Image/file downloads use the pinned encrypted CDN protocol and fixed official origin.

Feishu uses pinned `@larksuite/cli` subprocesses for app creation, credentials,
message/resource APIs and long-connection events. Setup verifies the app creator through
the application API, then uses their first fresh message to bind the destination.
CLI credentials live in its isolated Hub profile. Its configured app permissions, target availability,
API quotas and group membership apply independently of WeChat session policy.
Custom Webhooks do not satisfy the full product contract.

## Trust and lifecycle

WeChat/Relay credentials remain in native Hub credential storage. Feishu credentials
are owned by the official CLI (native storage on macOS/Windows, encrypted local files
on Linux). Nonsecret configuration
and ledgers are owner-only. Remote clients retain only their device credential.
Relay traffic is authenticated and encrypted; Relay has no durable outgoing queue.
An offline Hub returns failure. Temporary outgoing uploads are cleaned after delivery.
Incoming attachments use generated local paths in private bounded storage.

A secretary consumes only its channel's inbox under an exclusive lease. Inactive
secretaries do not collect new commands. Each channel has separate configuration,
service and current thread state. The selected working directory is explicit;
workspace permissions are the default, full access requires explicit user selection.
Codex owns conversation history and tool execution.

Optional root-task completion/question notifications are a separate opt-in feature.
They use the unified sender and default or explicitly configured channel selection.
Child-agent events are excluded. Hook installation and Codex trust are separate checks.

## Validation

Use package.json's check/build scripts. Provider adapters are tested with mocked
upstream interactions; those tests do not certify a real account's permissions,
notification settings, or end-to-end secretary delivery. Packaging must include both
channel references and all linked files in the unified skill directory.

The accepted unified product decision is [ADR 0009](docs/adr/0009-unified-messaging.md).
Feishu transport and onboarding are defined by [ADR 0010](docs/adr/0010-feishu-official-cli.md).
Earlier ADRs describe the original WeChat implementation; where scope differs,
ADR 0009 governs the current product and source implementation.
