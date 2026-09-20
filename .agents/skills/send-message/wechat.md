# WeChat channel

WeChat uses the QR-bound account through the pinned Tencent iLink protocol.
Run `send-message setup --channels wechat` and display the generated QR. The user
must scan, complete any verification, and send an initial message to the bot.

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
