import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runNotificationHook,
  type NotificationExecFile,
} from "../src/notifications/hook.js";
import {
  configureNotifications,
  NOTIFICATION_HOOK_MARKER,
} from "../src/notifications/install.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  transcript: string;
  state: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "send-message-notifications-"));
  roots.push(root);
  const transcript = join(root, "transcript.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({ type: "session_meta", payload: { id: "session-1", source: "cli", title: "  Demo   task " } })}\n`,
  );
  return { root, transcript, state: join(root, "state", "state.sqlite3") };
}

function execReturning(
  result: unknown,
  calls: Array<{ file: string; args: string[]; input: string }>,
  error: Error | null = null,
): NotificationExecFile {
  return ((file, args, _options, callback) => {
    const stdin = {
      end(input: string) {
        calls.push({ file, args, input });
      },
    };
    queueMicrotask(() => callback(error as never, JSON.stringify(result), ""));
    return { stdin } as never;
  }) as NotificationExecFile;
}

describe("notification hook", () => {
  it("filters to root Stop and question PreToolUse events and sends metadata only", async () => {
    const { transcript, state } = await fixture();
    const calls: Array<{ file: string; args: string[]; input: string }> = [];
    const deps = {
      statePath: state,
      nodeExecutable: "/usr/bin/node",
      cliEntry: "/opt/send-message/dist/cli/bin.js",
      channel: "feishu" as const,
      execFile: execReturning(
        {
          ok: true,
          command: "send",
          result: {
            state: "accepted",
            channels: { feishu: { ok: true, result: { state: "accepted" } } },
          },
        },
        calls,
      ),
    };
    const result = await runNotificationHook(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        transcript_path: transcript,
        body: "private transcript text must not be sent",
      },
      deps,
    );
    expect(result.outcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/node");
    expect(calls[0]?.args).toContain("--channel");
    expect(calls[0]?.input).toBe("Codex 提醒：「Demo task」回合已完成。");
    expect(calls[0]?.input).not.toContain("private transcript");

    const skipped = await runNotificationHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        turn_id: "turn-2",
        tool_name: "functions.shell",
        tool_use_id: "tool-1",
        transcript_path: transcript,
      },
      deps,
    );
    expect(skipped).toEqual({ outcome: "skipped", reason: "unsupported_tool" });
  });

  it("suppresses every duplicate, including an unknown sender outcome", async () => {
    const { transcript, state } = await fixture();
    const calls: Array<{ file: string; args: string[]; input: string }> = [];
    const deps = {
      statePath: state,
      execFile: execReturning(
        {
          ok: false,
          command: "send",
          result: {
            state: "partial",
            channels: {
              feishu: { ok: false, error: { code: "RESULT_UNKNOWN" } },
            },
          },
          error: { code: "CHANNEL_SEND_FAILED" },
        },
        calls,
      ),
    };
    const event = {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      tool_name: "request_user_input_async",
      tool_use_id: "tool-1",
      transcript_path: transcript,
    } as const;
    await expect(runNotificationHook(event, deps)).resolves.toMatchObject({
      outcome: "unknown",
      code: "RESULT_UNKNOWN",
    });
    await expect(runNotificationHook(event, deps)).resolves.toMatchObject({
      outcome: "deduplicated",
    });
    expect(calls).toHaveLength(1);
  });

  it("classifies a partial CLI envelope as failed unless a channel is unknown", async () => {
    const { transcript, state } = await fixture();
    const calls: Array<{ file: string; args: string[]; input: string }> = [];
    const deps = {
      statePath: state,
      execFile: execReturning(
        {
          ok: false,
          command: "send",
          result: {
            state: "partial",
            channels: {
              wechat: { ok: true, result: { state: "accepted" } },
              feishu: { ok: false, error: { code: "SERVER_REJECTED" } },
            },
          },
          error: { code: "CHANNEL_SEND_FAILED" },
        },
        calls,
      ),
    };
    await expect(
      runNotificationHook(
        {
          hook_event_name: "Stop",
          session_id: "session-1",
          turn_id: "partial-1",
          transcript_path: transcript,
        },
        deps,
      ),
    ).resolves.toMatchObject({
      outcome: "failed",
      code: "CHANNEL_SEND_FAILED",
    });
  });

  it("rejects child, untrusted, and malformed root events", async () => {
    const { transcript, state } = await fixture();
    const execFile = vi.fn<NotificationExecFile>();
    const base = {
      hook_event_name: "Stop" as const,
      session_id: "session-1",
      turn_id: "turn-1",
      transcript_path: transcript,
    };
    await expect(
      runNotificationHook(
        { ...base, agent_id: "child" },
        { statePath: state, execFile },
      ),
    ).resolves.toEqual({ outcome: "skipped", reason: "child_event" });
    await expect(
      runNotificationHook(
        { ...base, parent_thread_id: null },
        { statePath: state, execFile },
      ),
    ).resolves.toEqual({ outcome: "skipped", reason: "child_event" });
    await expect(
      runNotificationHook(
        { ...base, transcript_path: join((await fixture()).root, "missing") },
        { statePath: state, execFile },
      ),
    ).resolves.toEqual({ outcome: "skipped", reason: "untrusted_session" });
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("notification hook installation", () => {
  it("merges own Stop and PreToolUse hooks while preserving other entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-message-hooks-"));
    roots.push(root);
    const hooksPath = join(root, "hooks.json");
    await writeFile(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "keep-stop" }] },
            {
              hooks: [
                { type: "command", command: `old ${NOTIFICATION_HOOK_MARKER}` },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: "other",
              hooks: [{ type: "command", command: "keep-question" }],
            },
          ],
          PostToolUse: [{ hooks: [{ type: "command", command: "keep-post" }] }],
        },
      }),
    );
    const enabled = await configureNotifications({
      codexHome: root,
      enabled: true,
      channel: "both",
      cliEntry: "/opt/bin.js",
      nodeExecutable: "/usr/bin/node",
    });
    const merged = JSON.parse(await readFile(enabled.hooksPath, "utf8")) as {
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks?: Array<{ command?: string; commandWindows?: string }>;
        }>
      >;
    };
    expect(enabled.enabled).toBe(true);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop?.[0]?.hooks?.[0]?.command).toBe("keep-stop");
    expect(merged.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(
      "keep-question",
    );
    expect(merged.hooks.PreToolUse?.[1]?.matcher).toBe(
      "^(functions\\.)?request_user_input(_async)?$",
    );
    expect(merged.hooks.PreToolUse?.[1]?.hooks?.[0]?.command).toContain(
      "internal-notification-hook",
    );
    expect(merged.hooks.PreToolUse?.[1]?.hooks?.[0]?.commandWindows).toContain(
      "powershell.exe",
    );
    expect(merged.hooks.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(
      "keep-post",
    );
    expect(JSON.stringify(merged)).toContain(NOTIFICATION_HOOK_MARKER);
    expect(enabled.trustMessage).toContain("trusted hashes");

    await configureNotifications({
      codexHome: root,
      enabled: false,
      cliEntry: "/opt/bin.js",
      nodeExecutable: "/usr/bin/node",
    });
    const disabled = JSON.parse(await readFile(hooksPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(JSON.stringify(disabled)).not.toContain(NOTIFICATION_HOOK_MARKER);
    expect(JSON.stringify(disabled)).toContain("keep-stop");
    expect(JSON.stringify(disabled)).toContain("keep-question");
  });
});
