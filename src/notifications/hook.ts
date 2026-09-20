import {
  execFile as nodeExecFile,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const EVENT_INPUT_LIMIT = 1024 * 1024;
const TRANSCRIPT_FIRST_LINE_LIMIT = 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 20_000;
const QUESTION_TOOLS = new Set([
  "request_user_input",
  "request_user_input_async",
  "functions.request_user_input",
  "functions.request_user_input_async",
]);

export type NotificationChannel = "wechat" | "feishu" | "both";

export type NotificationHookEvent = {
  hook_event_name: "Stop" | "PreToolUse";
  session_id: string;
  turn_id: string;
  transcript_path: string;
  tool_name?: string;
  tool_use_id?: string;
  agent_id?: unknown;
  parent_thread_id?: unknown;
  title?: unknown;
  name?: unknown;
};

export type NotificationHookResult =
  | { outcome: "sent"; idempotencyKey: string }
  | { outcome: "deduplicated"; idempotencyKey: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "unknown" | "failed"; idempotencyKey: string; code: string };

export type NotificationExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (
    error: ExecFileException | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
) => ChildProcess;

export type NotificationHookDeps = {
  execFile?: NotificationExecFile;
  statePath?: string;
  nodeExecutable?: string;
  cliEntry?: string;
  channel?: NotificationChannel;
  now?: () => number;
};

type TranscriptPayload = {
  id?: unknown;
  source?: unknown;
  title?: unknown;
  name?: unknown;
  subagent?: unknown;
  parent_thread_id?: unknown;
  agent_path?: unknown;
};

type SenderOutcome = {
  status: "accepted" | "rejected" | "failed" | "unknown";
  code: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeTitle(value: unknown): string {
  if (!isNonEmptyString(value)) return "未命名任务";
  const title = value.replace(/\s+/gu, " ").trim().slice(0, 160);
  return title || "未命名任务";
}

function chooseTitle(...values: unknown[]): string {
  for (const value of values) {
    const title = normalizeTitle(value);
    if (title !== "未命名任务") return title;
  }
  return "未命名任务";
}

function parseInput(input: unknown): Record<string, unknown> | null {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > EVENT_INPUT_LIMIT) return null;
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return input !== null && typeof input === "object"
    ? (input as Record<string, unknown>)
    : null;
}

async function trustedTranscript(
  transcriptPath: unknown,
  sessionId: string,
): Promise<TranscriptPayload | null> {
  if (!isNonEmptyString(transcriptPath)) return null;
  let firstLine: Buffer;
  try {
    const metadata = await lstat(transcriptPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const handle = await open(transcriptPath, "r");
    try {
      const content = Buffer.alloc(TRANSCRIPT_FIRST_LINE_LIMIT + 1);
      const read = await handle.read(content, 0, content.length, 0);
      const lineEnd = content.subarray(0, read.bytesRead).indexOf(0x0a);
      firstLine = content.subarray(0, lineEnd < 0 ? read.bytesRead : lineEnd);
    } finally {
      await handle.close();
    }
    if (
      firstLine.length === 0 ||
      firstLine.length > TRANSCRIPT_FIRST_LINE_LIMIT
    )
      return null;
  } catch {
    return null;
  }
  try {
    const record: unknown = JSON.parse(firstLine.toString("utf8"));
    if (record === null || typeof record !== "object") return null;
    const payload = record as { type?: unknown; payload?: unknown };
    if (
      payload.type !== "session_meta" ||
      payload.payload === null ||
      typeof payload.payload !== "object"
    )
      return null;
    const metadata = payload.payload as TranscriptPayload;
    if (
      metadata.id !== sessionId ||
      typeof metadata.source !== "string" ||
      !["cli", "vscode", "exec"].includes(metadata.source)
    )
      return null;
    if ("subagent" in metadata || "parent_thread_id" in metadata) return null;
    if ("agent_path" in metadata && metadata.agent_path !== "/root")
      return null;
    return metadata;
  } catch {
    return null;
  }
}

function idempotencyKey(
  sessionId: string,
  turnId: string,
  eventName: string,
  toolUseId: string,
): string {
  const json = JSON.stringify([sessionId, turnId, eventName, toolUseId]);
  // Keep the hook key compatible with the bounded local hook: its Python
  // implementation hashes compact JSON with ensure_ascii=true.
  const asciiJson = json.replace(/[^\u0000-\u007f]/gu, (character) => {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0xffff)
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    const value = codePoint - 0x10000;
    const high = 0xd800 + (value >> 10);
    const low = 0xdc00 + (value & 0x3ff);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low
      .toString(16)
      .padStart(4, "0")}`;
  });
  return createHash("sha256")
    .update(asciiJson)
    .digest("hex")
    .replace(/^/, "codex-hook-");
}

function messageFor(title: string, eventName: "Stop" | "PreToolUse"): string {
  return `Codex 提醒：「${title}」${eventName === "Stop" ? "回合已完成" : "有问题需要你回答"}。`;
}

function defaultStatePath(): string {
  return join(
    process.env.HOME ?? ".",
    ".codex",
    "hooks",
    "notifications",
    "state.sqlite3",
  );
}

async function openLedger(path: string): Promise<DatabaseSync> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("STATE_UNSAFE");
  await chmod(dirname(path), 0o700);
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error("STATE_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
    } else {
      throw error;
    }
  }
  await chmod(path, 0o600);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { timeout: 3000 });
    await chmod(path, 0o600);
    database.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 3000;",
    );
    database.exec(`CREATE TABLE IF NOT EXISTS notifications (
      idempotency_key TEXT PRIMARY KEY,
      attempted_at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'finished', 'unknown'))
    )`);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      /* preserve the original ledger failure */
    }
    throw error;
  }
}

async function claim(
  path: string,
  key: string,
  now: number,
): Promise<{ database: DatabaseSync; claimed: boolean }> {
  const database = await openLedger(path);
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("DELETE FROM notifications WHERE attempted_at < ?")
      .run(now - RETENTION_MS);
    const result = database
      .prepare(
        "INSERT OR IGNORE INTO notifications (idempotency_key, attempted_at, outcome) VALUES (?, ?, 'pending')",
      )
      .run(key, now);
    database.exec("COMMIT");
    return { database, claimed: Number(result.changes) === 1 };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* preserve the original ledger failure */
    }
    try {
      database.close();
    } catch {
      /* preserve the original ledger failure */
    }
    throw error;
  }
}

function finish(
  database: DatabaseSync,
  key: string,
  outcome: "finished" | "unknown",
): void {
  try {
    database
      .prepare("UPDATE notifications SET outcome = ? WHERE idempotency_key = ?")
      .run(outcome, key);
  } finally {
    try {
      database.close();
    } catch {
      /* preserve an update failure or the delivery outcome */
    }
  }
}

function safeResultCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Z0-9_]{1,64}$/u.test(value)
    ? value
    : fallback;
}

function channelHasUnknown(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const channel = value as {
    state?: unknown;
    result?: { state?: unknown };
    error?: { code?: unknown };
  };
  return (
    channel.state === "unknown" ||
    channel.result?.state === "unknown" ||
    (typeof channel.error?.code === "string" &&
      channel.error.code.endsWith("_UNKNOWN"))
  );
}

function parseSenderOutcome(
  error: ExecFileException | null,
  stdout: string | Buffer,
): SenderOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof stdout === "string" ? stdout : stdout.toString("utf8"),
    );
  } catch {
    parsed = null;
  }
  const record =
    parsed !== null && typeof parsed === "object"
      ? (parsed as {
          ok?: unknown;
          command?: unknown;
          result?: {
            state?: unknown;
            channels?: Record<string, unknown>;
          };
          error?: { code?: unknown };
        })
      : {};
  const result = record.result;
  if (
    record.command === "send" &&
    result !== undefined &&
    typeof result === "object" &&
    result !== null &&
    result.channels !== undefined &&
    typeof result.channels === "object" &&
    result.channels !== null
  ) {
    const channels = Object.values(result.channels);
    const unknown = channels.some(channelHasUnknown);
    if (unknown) return { status: "unknown", code: "RESULT_UNKNOWN" };
    if (!error && record.ok === true && result.state === "accepted")
      return { status: "accepted", code: "ACCEPTED" };
    if (result.state === "partial" || result.state === "failed") {
      return {
        status: "failed",
        code: safeResultCode(record.error?.code, "CHANNEL_SEND_FAILED"),
      };
    }
  }
  if (error?.killed || error?.code === "ETIMEDOUT")
    return { status: "unknown", code: "TIMEOUT" };
  if (error?.code === "ENOENT" || error?.code === "EACCES")
    return { status: "failed", code: "SENDER_UNAVAILABLE" };
  return { status: "unknown", code: "SENDER_ERROR" };
}

function sendWithCli(
  message: string,
  key: string,
  deps: NotificationHookDeps,
): Promise<SenderOutcome> {
  const executable = deps.nodeExecutable ?? process.execPath;
  const entry = deps.cliEntry ?? join(process.cwd(), "dist", "cli", "bin.js");
  const args = [entry, "--json", "send", "--stdin", "--idempotency-key", key];
  if (deps.channel !== undefined) args.push("--channel", deps.channel);
  const exec = deps.execFile ?? nodeExecFile;
  return new Promise((resolve) => {
    let child: ChildProcess;
    let dispatched = false;
    try {
      child = exec(
        executable,
        args,
        { timeout: SEND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          resolve(parseSenderOutcome(error, stdout));
        },
      );
      dispatched = true;
      child.stdin?.end(message, "utf8");
    } catch (error) {
      resolve({
        status: dispatched ? "unknown" : "failed",
        code: dispatched
          ? "SENDER_ERROR"
          : error instanceof Error
            ? "SENDER_ERROR"
            : "SENDER_UNAVAILABLE",
      });
    }
  });
}

export async function runNotificationHook(
  input: unknown,
  deps: NotificationHookDeps = {},
): Promise<NotificationHookResult> {
  const event = parseInput(input);
  if (event === null) return { outcome: "skipped", reason: "malformed_event" };
  const eventName = event.hook_event_name;
  if (eventName !== "Stop" && eventName !== "PreToolUse")
    return { outcome: "skipped", reason: "unsupported_event" };
  if ("agent_id" in event || "parent_thread_id" in event)
    return { outcome: "skipped", reason: "child_event" };
  const sessionId = event.session_id;
  const turnId = event.turn_id;
  const transcriptPath = event.transcript_path;
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(turnId))
    return { outcome: "skipped", reason: "missing_identity" };
  let toolUseId = "";
  if (eventName === "PreToolUse") {
    if (
      typeof event.tool_name !== "string" ||
      !QUESTION_TOOLS.has(event.tool_name)
    )
      return { outcome: "skipped", reason: "unsupported_tool" };
    if (!isNonEmptyString(event.tool_use_id))
      return { outcome: "skipped", reason: "missing_tool_use_id" };
    toolUseId = event.tool_use_id;
  }
  const transcript = await trustedTranscript(transcriptPath, sessionId);
  if (transcript === null)
    return { outcome: "skipped", reason: "untrusted_session" };
  const key = idempotencyKey(sessionId, turnId, eventName, toolUseId);
  let claimed: { database: DatabaseSync; claimed: boolean };
  try {
    claimed = await claim(
      deps.statePath ?? defaultStatePath(),
      key,
      (deps.now ?? Date.now)(),
    );
  } catch {
    return { outcome: "failed", idempotencyKey: key, code: "STATE_ERROR" };
  }
  if (!claimed.claimed) {
    try {
      claimed.database.close();
    } catch {
      /* duplicate state is already durable */
    }
    return { outcome: "deduplicated", idempotencyKey: key };
  }
  const title = chooseTitle(
    transcript.title,
    transcript.name,
    event.title,
    event.name,
  );
  const outcome = await sendWithCli(messageFor(title, eventName), key, deps);
  let stateWriteFailed = false;
  try {
    finish(
      claimed.database,
      key,
      outcome.status === "unknown" ? "unknown" : "finished",
    );
  } catch {
    stateWriteFailed = true;
  }
  if (stateWriteFailed)
    return {
      outcome: "unknown",
      idempotencyKey: key,
      code: "STATE_WRITE_FAILED",
    };
  if (outcome.status === "unknown")
    return { outcome: "unknown", idempotencyKey: key, code: outcome.code };
  if (outcome.status === "failed" || outcome.status === "rejected")
    return { outcome: "failed", idempotencyKey: key, code: outcome.code };
  return { outcome: "sent", idempotencyKey: key };
}
