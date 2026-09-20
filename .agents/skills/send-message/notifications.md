# Codex task notifications

This optional feature notifies about root-task turn completion and questions requiring
an answer. It excludes subagents and sends only task title and event type. A completed
turn does not certify completion of an entire project.

After the user opts in, use `send-message notifications --enable`. Leave its channel
unspecified to use the Hub default, or provide `--channel wechat|feishu|both` following
the user's choice. `both` must be explicit. Use `--disable` to remove only this tool's
notification hooks while preserving other Codex hooks.

The command edits the user's Codex hooks configuration and reports its location.
Codex must trust the resulting hook definition; complete that review in Codex and
restart/reload the session when needed. A written hooks file does not prove the
currently running task has loaded it. Check a new root task and a real notification.

The sender maintains channel-specific idempotency and the notification hook records
events before sending. Unknown results, duplicate hook invocations, and accepted sends
are never automatically replayed. Configure the underlying channel first using
[setup.md](setup.md), and diagnose provider errors in its channel reference.

Reference: [OpenAI Hooks](https://learn.chatgpt.com/docs/hooks), the Stop, PreToolUse,
and Review and trust hooks sections.
