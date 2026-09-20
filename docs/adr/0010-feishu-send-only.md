# ADR 0010: Feishu outbound delivery only

Status: Accepted, 2026-09-20.

## Decision

The user removed Feishu chat interaction from the product. Feishu supports outbound
text-only group Webhook delivery, including optional Codex task notifications. WeChat
retains its existing secretary and incoming attachment handling.

Remove Feishu event subscriptions, WebSocket receiving, inbound resource downloads,
inbox creation, gateway configuration, and owner identity for incoming authorization.
The gateway accepts only `--channel wechat`. Requests for a Feishu inbox fail without
falling back to the WeChat inbox. No compatibility or configuration migration is added.

Feishu uses a custom group robot Webhook and optional signing secret. Remove app
credentials, recipient IDs, upload APIs, and the official application SDK dependency.
The Webhook fixes the destination group. No app-based sender fallback is retained.
Image/file commands fail with FEISHU_TEXT_ONLY without contacting Feishu; an explicit
both-media send retains the independent WeChat outcome. Setup and doctor perform local
configuration validation only; an authorized send is needed for live acceptance.

## Superseded scope

This decision supersedes the Feishu secretary, per-channel conversations, and owner
input validation in ADR 0009. Its channel selection, independent send results,
idempotency, optional Relay, and no automatic channel switching decisions remain.

## Validation

Test that Feishu is rejected before gateway state or service creation, that all Feishu
inbox operations fail, and that Feishu text sending, WeChat media sending, and WeChat interaction remain.
Real account permissions and device receipt still require separate acceptance.
