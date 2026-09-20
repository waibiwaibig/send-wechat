# send-message

send-message is an Agent-first command-line tool for delivering text, images, and
files through WeChat, and text notifications through Feishu group Webhooks. One Hub owns the configured provider credentials
and fixed recipients. Each user chooses WeChat, Feishu, or both during installation;
a dual-channel installation has one explicit default.

## Domain vocabulary

- **Channel**: `wechat` or `feishu`, with independent credentials, limits, and
  idempotency ledger. Only WeChat has an inbox and secretary conversation.
- **Selection**: one channel, or explicit `both`. An omitted selector uses the Hub's
  default channel. Failure never changes selection.
- **Local Hub**: single-machine installation, with an owner-only local IPC endpoint.
  It needs no Cloudflare account or public address.
- **Relay Hub**: the same provider-owning machine with an optional personal Cloudflare
  Relay for paired remote clients. The Hub stays online.
- **Client**: a paired device with its own Relay credential, without provider secrets.
- **Secretary**: a separately enabled WeChat Codex CLI conversation. Incoming
  owner text/images/files enter that conversation and replies use WeChat.
- **Accepted**: the provider acknowledged the request. Device receipt/read state is
  not inferred. Unknown results remain terminal until human investigation.

## Product boundaries

`send-message` and the complete `.agents/skills/send-message` directory are the public
sending and Agent installation entry points. The optional `send-message-gateway` runs
secretary services. The old command and skill names have no compatibility aliases.
GitHub hosting remains at `waibiwaibig/send-wechat` until separately renamed.

Each channel has one fixed target. WeChat binds by QR to one user. Feishu uses a
custom group robot Webhook that fixes the notification group.
Feishu is send-only and accepts no incoming commands.
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

Feishu uses one HTTPS Webhook request per text send, with optional timestamp/HMAC
signing. No application token, upload API, event subscription, or message-reading
scope is used. Image and file commands fail with FEISHU_TEXT_ONLY without network
I/O. Explicit both-media sends report each channel independently. Setup and doctor
validate local configuration only; real robot security settings require an authorized
send to verify. A successful Webhook response provides no platform message ID; the
reported clientMessageId is local correlation metadata. No request is auto-retried.

## Trust and lifecycle

Provider credentials remain in native Hub credential storage. Nonsecret configuration
and ledgers are owner-only. Remote clients retain only their device credential.
Relay traffic is authenticated and encrypted; Relay has no durable outgoing queue.
An offline Hub returns failure. Temporary outgoing uploads are cleaned after delivery.
Incoming attachments use generated local paths in private bounded storage.

The WeChat secretary consumes its inbox under an exclusive lease. An inactive
secretary does not collect new commands. It has its own configuration, service and
current thread state. The selected working directory is explicit;
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
Earlier ADRs describe the original WeChat implementation; where scope differs,
ADR 0009 governs the current product and source implementation.

[ADR 0010](docs/adr/0010-feishu-send-only.md) supersedes ADR 0009 for Feishu
interaction scope: Feishu sends messages only; the secretary is WeChat-only.
