# ADR 0010: Feishu through the official CLI

Status: Accepted, 2026-09-20. First-message onboarding updated 2026-09-22.

## Decision

Use the pinned `@larksuite/cli` package as the sole Feishu transport. Package installation
provides its native executable; the Hub resolves that executable from its dependency,
not the shell PATH. The Node SDK and manual app-secret/recipient JSON setup are removed.
This updates ADR 0009's Feishu implementation while retaining its channel semantics.

The official CLI owns app creation and credentials in an isolated send-message profile.
The sender owns fixed recipient configuration, owner authorization, queues and persistent
idempotency. Commands run as the application bot with argument arrays and structured
responses. No personal OAuth login is required. Setup displays the official registration
link, resolves the current application creator with the application-information API,
waits for event readiness, and displays a direct bot-chat AppLink with desktop/mobile
search instructions. The creator sends any fresh message to bind a DM; a group binding
requires a bot mention followed by ordinary text and fixes both the owner and group. Rerunning setup reuses credentials and completed bindings; explicit rebind
replaces a target only after successful verification.

Both sending and optional secretary receiving use CLI subprocesses. Incoming events use
the CLI's documented flattened schema; media resource keys come from message API data.
Only bound-owner messages reach the secretary. Subscription startup waits for the ready
marker and keeps stdin open. Child process failures must not masquerade as delivery.
Unknown send outcomes remain terminal in the existing ledger.

DM bindings retain the first authorized message's private chat ID and the app creator's open ID.
All outgoing messages address that verified chat; incoming DMs require both the owner
and that same private chat. Existing DM configurations without a chat ID require an
explicit rebind. A failed rebind leaves the previous configuration intact.

Media delivery uses the CLI's typed image/file upload commands followed by message
submission with the returned resource key. Generic file attachments use `stream`,
including Markdown files. Each stage has its own bounded timeout and safe error code.
Upload failure cannot submit a message; ambiguous message submission stays terminal.
The ledger retains the safe cause and outcome category across daemon restarts.
Status reports configuration readiness separately from observed listener, inbox and
send health. Observation timestamps are process-local; the persistent ledger remains
the source for a particular idempotency key's outcome.

The pinned CLI requests scanner user information internally but omits it from its
`config init --new` output. Setup therefore queries
`GET /open-apis/application/v6/applications/me` with `user_id_type=open_id` and uses
`app.creator_id` as its authorization source. Identity lookup failure stops setup
before message binding. Existing complete bindings remain reusable. No random code
or extra user confirmation is required.

## Consequences

An extra native binary is downloaded during dependency installation. Its exact version
and output contract must be tested together. The application supplies one public command
and one small skill; users do not install a second broad skill set or look up open_id.
Linux credentials use the CLI's storage implementation, so Feishu-only local installation
does not depend on a desktop keyring. WeChat and Relay retain their credential requirements.

No Webhook, SDK fallback, old config migration, or automatic channel switching is added.
Incoming resource downloads use a private temporary directory. The 100 MiB import limit
is checked after the CLI download completes; the upstream shortcut does not expose a
streaming byte cap, so temporary disk usage can exceed that limit before cleanup.
Mocked protocol tests and local binary smoke checks do not replace real-account delivery
or clean WSL service/restart acceptance.

## References

- [CLI quick start and authentication](https://github.com/larksuite/cli/blob/main/README.zh.md)
- [Message sending parameters and identity](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md)
- [Event subprocess contract](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)
- Pinned v1.0.96: [media resolution before message submission](https://github.com/larksuite/cli/blob/v1.0.96/shortcuts/im/im_messages_send.go#L213-L263),
  [generic file type selection](https://github.com/larksuite/cli/blob/v1.0.96/shortcuts/im/helpers.go#L1251-L1273),
  and [successful API payload extraction](https://github.com/larksuite/cli/blob/v1.0.96/internal/output/envelope_success.go#L17-L49).
  Local binary contracts are checked using `event consume --help`, `im files create --help`,
  `im images create --help`, and the corresponding `schema` commands; these perform no delivery.

- [Application information API — own-app lookup and creator identity](https://open.feishu.cn/document/server-docs/application-v6/application/get).
  The official SDK defines
  [Application.CreatorId as the app creator/owner](https://github.com/larksuite/oapi-sdk-go/blob/main/service/application/v6/model.go#L3103-L3106)
  and supports [me in GetApplicationReqBuilder.AppId](https://github.com/larksuite/oapi-sdk-go/blob/main/service/application/v6/model.go#L8162-L8185).
- [Pinned CLI registration result fields](https://github.com/larksuite/cli/blob/v1.0.96/internal/auth/app_registration.go#L70-L81)
  and [public config-init output](https://github.com/larksuite/cli/blob/v1.0.96/cmd/config/init.go#L431-L439).
- [Bot-opening AppLink — showRobot example](https://www.feishu.cn/content/7270877743058698268).
