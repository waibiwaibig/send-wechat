# ADR 0007: Optional single-conversation Codex gateway

Status: accepted

## Decision

Publish `send-wechat-gateway` as a second executable in the existing package.
It runs as an independently managed process on the Hub and connects to a
Codex CLI app-server over stdio. It owns one current thread pointer. Codex
owns conversation history, model execution, tools and any work it delegates.
The gateway has no model, task router, session browser or cross-session tools.

Agent-first onboarding keeps the existing sending setup as the first completed
outcome. The packaged send-wechat skill then offers the secretary once during
that onboarding conversation. A user's opt-in authorizes routine Codex and
gateway setup on the existing Hub; a decline leaves sending ready. Direct
secretary setup requests already supply this choice. Ordinary sends and repair
tasks do not trigger an offer. The skill ships a self-contained gateway guide
so copying the whole skill directory preserves both installation paths.

The gateway runs independently of the desktop application. `/newchat` is the
sole in-chat gateway command: interrupt the current turn, persist a null thread
pointer, and discard late output from the old generation. The next ordinary
input creates the fresh thread. Empty app-server threads have no durable rollout
yet, so this avoids persisting a reference that cannot be resumed after restart.
Ordinary input interrupts an active turn, waits for
its completion notification, then starts a turn in the same thread. Consecutive
ordinary messages in one inbox batch retain order in one input; `/newchat`
separates batches.

## Module boundary

The base Hub retains all Weixin credentials, network access, polling, session
renewal, delivery scheduling and delivery-result interpretation. An optional
generic local text inbox is exposed through authenticated IPC. Only text from
the bound user enters it. The Relay protocol and remote-client behavior do not
change. There is no second Weixin poller or independent login in the gateway.

The inbox is lazy and collects new text only while an exclusive consumer lease
is active. It retains unacknowledged messages and duplicate-suppression metadata
for bounded recovery. A failed optional inbox cannot stop the base polling or
ordinary sending path. Such isolation prefers continuity of the established
transport over guaranteed retention of commands during inbox failure.

This changes ADR 0003's unconditional inbound-content discard policy only while
an inbox consumer is active. A stopped or unconfigured gateway does not turn
the Hub into a persistent archive of inbound content.

The gateway keeps its own owner-only configuration, thread pointer, input
handoff journal and runtime status. Input is recorded before dispatch to Codex.
A crash across that handoff leaves an uncertain outcome, which is reported and
never automatically replayed. This is duplicate avoidance, not an exactly-once
execution guarantee. Existing Weixin `accepted` and `result_unknown` contracts
continue to apply to every output block.

## Output and runtime

Only user-visible agent message events are projected to Weixin. Repeated full
message completion events do not duplicate deltas. Block coalescing bounds
memory and submits at most one send at a time, leaving the Hub's common
delivery queue available to other callers. Invalidation drops unsubmitted old
blocks; already submitted network operations can finish. New-chat confirmation
is ordered after any such submitted block.

Use the verified upstream block-streaming pattern. Do not infer same-bubble
editing from the presence of `GENERATING`, `seq` or `client_id` in upstream
types. The existing complete-message send path and pacing remain authoritative.

The Codex adapter inherits the selected user's authentication and configuration;
it does not enable elevated permissions or auto-approve server requests.
Unsupported interactive requests receive explicit rejection and a visible
notice, avoiding an indefinitely blocked gateway. App-server protocol changes
fail explicitly rather than selecting another runtime or a legacy interface.

The platform service module accepts an explicit service identity so both
executables share the existing platform implementation with distinct service
names and files. The gateway can be stopped or removed independently. Existing
send-wechat service behavior remains the default identity and is covered by
regression tests.

## Consequences

Users retain a simple Weixin entry point and one conversation until they ask
for a new one. Base text/file sending does not depend on Codex availability or
gateway health. The integration does depend on the installed Codex CLI's
app-server protocol; protocol tests, real model execution and real Weixin
delivery remain separate validation stages.
