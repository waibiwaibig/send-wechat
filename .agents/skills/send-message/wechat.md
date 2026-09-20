# WeChat channel

WeChat uses the QR-bound account through the pinned Tencent iLink protocol.
The Agent runs `send-message setup --channels wechat` on the authorized machine and
shows the generated QR to the user. Keep a dual-channel selection when both was chosen.
Guide one action at a time: scan with the intended WeChat account, complete any provider
verification, then send an initial message to the bot in WeChat. If a QR expires, obtain
a fresh one through the CLI and explain that the prior QR is no longer the one to scan.

Checkpoint: setup succeeded and status shows fresh bound-user context. Continue with
[setup.md](setup.md)'s authorized test and user-confirmed receipt. If QR rendering or
verification is blocked, report the actual prompt/error and help complete that step;
do not stop after printing an installation command. The bot target is the QR-bound
user, not an arbitrary desktop contact or group selected by the Agent.

Session state is specific to WeChat. A fresh inbound message refreshes context;
after 23 hours the local renewal reminder is due, and at 24 hours sending is blocked.
Have the bound user send `/recover` to renew the context. Stale login requires setup
and QR authentication again. `/recover` is handled by the Hub, outside the secretary.

`ready` means the local session checks pass. The upstream service can still reject
active messages. Treat `SERVER_REJECTED` as rejection and retain its cause code;
there is no guaranteed daily quota or promise that local readiness ensures delivery.
Do not keep retrying, switch channels, or advise evading upstream restrictions.

Text is limited to 4,000 Unicode characters; media is bounded to 100 MiB locally.
Images and files use the encrypted iLink CDN protocol. The secretary accepts text,
images, and files only from the bound user. Unsupported content is outside this scope.
