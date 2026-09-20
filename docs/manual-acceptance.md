# Manual acceptance

Automated protocol tests do not certify a real provider account or native background
service. Record platform, package version, selected channels and actual observations.
Never include credentials, QR values, pairing invitations or message bodies in reports.

## Fresh installation

- Install the packed artifact on Node.js 24+ and discover the complete global skill
  in a fresh Agent session. Verify the public command is `send-message`.
- Configure WeChat-only, Feishu-only and both. Both must have an explicit default.
- A local installation must not invoke Cloudflare authorization/provisioning.
- WeChat QR activation and Feishu Webhook configuration checks are separate.
- Test explicit Relay activation and a paired client with only device credentials.

## Delivery

- Send authorized text through both channels, and images/files through WeChat, locally
  and from a paired client. Verify the fixed user/group and actual media type.
- Feishu media must fail with FEISHU_TEXT_ONLY without contacting its Webhook.
- Test unsigned and signed Webhooks, keyword/IP rejection, timeout, and throttling.
- Setup and doctor must not send probes or claim remote credential verification.
- Omitted selector uses the Hub default. Explicit selection stays on that channel.
- `both` produces two outcomes. Force one failure and confirm the accepted side is not
  repeated. Unknown-result retry with the same key must not resend.
- Verify local status, API acceptance, actual message receipt and phone/Mac reminders
  independently. Check WeChat expiry/recovery without changing the Feishu channel.

## Secretary

- On macOS, Linux/WSL and Windows, install the WeChat service and inspect its exact
  `--channel wechat` startup arguments and saved thread ID.
- Explicit cwd and default workspace permissions must hold for new threads and turns.
- Send owner text, image and file; verify Codex input and reply through the same channel.
- Reject `--channel feishu` before creating gateway state or starting a service.
- Feishu inbox requests must fail; no Feishu event connection or inbox is created.
- Stop a channel's gateway, send input, restart: inactive input must not become commands.
- Restart an active service and confirm the existing channel thread resumes.
- Verify attachment errors are visible and staged content is private and bounded.

## Codex notifications

- Enable only after opt-in. Inspect hooks.json preservation of unrelated hooks.
- Review/trust the new definitions in Codex, reload if necessary, then exercise a new
  root task's Stop and question event. A subagent must not notify.
- Verify duplicate events and unknown sends are not replayed, including after changing
  the default channel. Disable and check that unrelated hooks remain intact.

## Reset

- Reset confirmation is required. Client-local reset must not delete Hub credentials.
- Hub reset removes channel credentials and owned state; Relay deletion failures must
  be reported while enough management state remains to recover.
- Check interrupted configuration/provisioning and failed service restarts explicitly.
