# ADR 0009: Unified WeChat and Feishu messaging

Status: Accepted, 2026-09-20. Feishu interaction scope superseded by
[ADR 0010](0010-feishu-send-only.md).

## Decision

Use one product, `send-message`, one user-facing Agent skill, and independent WeChat
and Feishu adapters. Installer Agents ask for WeChat, Feishu, or both. Both requires
an explicit default channel. An omitted send selector resolves on the Hub; `both`
is always explicit. A failed channel never triggers another channel automatically.

One fixed recipient is configured per channel. WeChat keeps its QR-bound user;
Feishu uses a self-built application's owner DM or a chosen group. Group-based
secretary input additionally checks the owner's open_id. No arbitrary recipient
parameter is exposed.

Single-machine installations use local IPC and do not provision Cloudflare. Users
who add remote devices explicitly enable a personal Relay. Provider credentials stay
on the Hub, and remote clients hold only their own device credentials. No offline
outbox or fallback delivery is introduced.

Text, images, and files are supported through separate provider mappings. WeChat
session policy and Feishu API permissions/limits remain channel-specific. Send results
report each selected channel; partial success is retained. Separate idempotency ledgers
prevent one channel's accepted or unknown operation from being replayed during repair.

Optional Codex task notifications and the secretary are separate choices. Notifications
exclude subagents. Each enabled secretary channel has its own thread, service/config,
lease, and inbox. Replies return to the incoming channel. Text/images/files are mapped
to Codex input using actual app-server capabilities and local staged resources.
The working directory is explicit, workspace permissions default, and full access opt-in.

The unified skill explains both channels and branches to provider-specific references.
Existing CLI/skill aliases are removed. There is no state migration or compatibility
layer. Public GitHub repository renaming and package publication require separate work.

## Superseded scope

This decision replaces the WeChat-only naming, mandatory Relay, text-only secretary,
and full-access default portions of ADRs 0001, 0002, 0006, and 0007. Their remaining
protocol, encryption, idempotency, and file-safety constraints continue to apply.

## Consequences

An existing Webhook-only notification setup cannot provide the full Feishu channel;
it needs app-bot onboarding. API acceptance and actual device receipt remain distinct.
Tests must exercise default/explicit/both routing, independent failures, attachment
mapping, owner-only input, and explicit single-machine/multi-device setup.
