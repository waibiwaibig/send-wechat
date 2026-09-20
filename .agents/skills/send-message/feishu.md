# Feishu: scan, bind, verify

Feishu uses the bundled official `@larksuite/cli` as the application bot. All sending,
receiving and resource transfers go through that CLI. Use `send-message` commands;
setup owns an isolated CLI profile, so a separate global `lark-cli` configuration does
not configure this sender. No App Secret, open_id or chat_id needs to be pasted into chat.

## Connect

1. Default to the user's private bot conversation. If a group is requested, add
   `--feishu-target group` to setup. Keep the channel/default choices from [setup.md](setup.md).
2. Run `send-message setup --channels feishu` (or the selected dual-channel command).
   Keep the process running and show its official app-creation link/QR to the user.
   They log in/scan and create a dedicated send-message app. The CLI saves its credentials.
   Existing configured bindings are verified and reused when setup is rerun.
3. Wait for **连接已就绪** and the binding code. Show the bot name and code. For private
   delivery, the user searches for that bot in Feishu, opens its chat and sends only the
   code. For a group, they add the bot, then send **@bot followed by the code** in that
   group. The installing user sends it personally. The code expires after ten minutes.
4. Wait for **接收人已绑定** and successful setup. Return to [setup.md](setup.md)'s
   delivery test. Verify text, and requested image/file delivery, in that exact chat.

The application identity sends messages to the user. Personal `auth login --recommend`
is unnecessary for this flow. Bot permissions, application availability, administrator
approval and API quotas still apply. App creation and recipient binding are separate
checkpoints; presenting a scan link alone does not complete either.

## Resume or change the target

After timeout, rerun setup: it reuses the stored CLI profile and generates a fresh code.
For an intentional recipient change, run `send-message setup --feishu-rebind`, adding
`--feishu-target group` or `--feishu-target dm` for the desired mode. The previous binding
is retained until a valid new challenge is received. A new group binding also fixes the
owner whose messages may reach the optional secretary.

## Repair only the failing checkpoint

- **CLI missing/install failure:** repair the package installation and its native-binary
  download. Use the version pinned by this sender; arbitrary global CLI upgrades are
  outside its tested contract.
- **Scan link expired:** rerun setup and show the new link. An approval pending in the
  user's organization must finish before claiming success.
- **Bot missing from search/group picker:** check the selected tenant and app availability
  in the developer console; guide pending publication/admin approval shown there.
- **No binding prompt / incoming event permission error:** check the app's robot capability,
  message-receive event and long-connection configuration. Newly created smart-agent apps
  preconfigure these; an existing app may need correction. Show the exact failed
  permission and the next console action. No public callback server is needed.
- **Code ignored:** use the current code in the selected chat type. A group message needs
  exactly one mention of this bot, followed by the code, sent by the intended owner.
- **Send rejected:** check the reported API code, target availability/group membership,
  send-as-bot permission and resource permission for media. Keep the same channel.
- **Unknown send outcome:** investigate the conversation before another send.

Text is locally limited to 4,000 characters; images to 10 MiB and files to 30 MiB.
The [secretary](gateway.md) is optional and accepts only the bound owner's messages.

Official references, read only when that checkpoint needs detail:
[app creation — configuration checklist](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview.md),
[CLI send — parameters/identity](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md),
[CLI events — subprocess contract](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md).
