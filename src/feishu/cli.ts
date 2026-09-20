import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const DEFAULT_PROFILE = "send-message";
const DEFAULT_TIMEOUT_MS = 30_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 2 * 1024 * 1024;

export type FeishuCliRunOptions = {
  cwd?: string;
  timeoutMs?: number;
};

export class FeishuCliError extends Error {
  public readonly code: string;
  public readonly exitCode: number | undefined;

  public constructor(code: string, exitCode?: number) {
    super(code);
    this.name = "FeishuCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export type FeishuCliSubscription = {
  close(): void;
  isOpen?: () => boolean;
};

export type FeishuCliOutputCallback = (text: string) => void | Promise<void>;

export type FeishuCliRunner = Pick<
  FeishuCli,
  "run" | "subscribe" | "configure" | "removeProfile"
>;

type ProcessResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
};

const closeTimers = new WeakMap<
  ChildProcessWithoutNullStreams,
  ReturnType<typeof setTimeout>
>();

function safePath(path: string): string {
  return resolve(path);
}

function safeErrorCode(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value))
    return `FEISHU_${value}`;
  if (typeof value === "string") {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    if (/^[A-Z][A-Z0-9_]{1,80}$/.test(normalized)) return `CLI_${normalized}`;
  }
  return null;
}

function parsedJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new FeishuCliError("CLI_MALFORMED_OUTPUT");
  }
}

function tryParsedJson(text: string): unknown {
  try {
    return parsedJson(text);
  } catch {
    return null;
  }
}

function isRawJsonCommand(args: readonly string[]): boolean {
  return (
    (args[0] === "profile" && args[1] === "list") ||
    (args[0] === "config" && args[1] === "show")
  );
}

function isNonEnvelopeCommand(args: readonly string[]): boolean {
  return (
    isRawJsonCommand(args) ||
    (args[0] === "config" && args[1] === "remove") ||
    (args[0] === "profile" && args[1] === "remove")
  );
}

function isConfigCommand(args: readonly string[]): boolean {
  return args[0] === "config" && args[1] === "init";
}

function usesBotIdentity(args: readonly string[]): boolean {
  return args[0] !== "profile" && args[0] !== "config";
}

function appendDefaults(args: readonly string[], profile: string): string[] {
  const result = [...args, "--profile", profile];
  if (usesBotIdentity(args)) result.push("--as", "bot", "--format", "json");
  return result;
}

function environment(configDir: string, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Explicit per-process paths win over inherited CLI state. These values can
  // otherwise select another app, profile, or agent workspace.
  for (const key of Object.keys(env))
    if (
      key.startsWith("LARKSUITE_CLI_") ||
      key.startsWith("OPENCLAW_") ||
      key.startsWith("HERMES_") ||
      key.startsWith("FEISHU_") ||
      key === "LARK_CHANNEL"
    )
      delete env[key];
  env.LARKSUITE_CLI_CONFIG_DIR = configDir;
  env.LARKSUITE_CLI_DATA_DIR = dataDir;
  return env;
}

function binaryPath(): string {
  const packageJson = require.resolve("@larksuite/cli/package.json");
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(dirname(packageJson), "bin", `lark-cli${suffix}`);
}

export class FeishuCli {
  private readonly configDir: string;
  private readonly dataDir: string;
  private readonly binary: string;

  public constructor(
    private readonly stateDir: string,
    private readonly profile = DEFAULT_PROFILE,
  ) {
    this.configDir = safePath(join(stateDir, "feishu-cli", "config"));
    this.dataDir = safePath(join(stateDir, "feishu-cli", "data"));
    this.binary = binaryPath();
  }

  public async run(
    args: string[],
    options: FeishuCliRunOptions = {},
  ): Promise<unknown> {
    const commandArgs = isConfigCommand(args)
      ? [...args]
      : appendDefaults(args, this.profile);
    const result = await this.execute(commandArgs, {
      cwd: options.cwd ?? this.stateDir,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const parsed = tryParsedJson(result.stdout);
    if (result.status !== 0)
      throw this.errorFromFailure(
        parsed ?? tryParsedJson(result.stderr),
        result.status ?? undefined,
      );
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const envelope = parsed as {
        ok?: unknown;
        data?: unknown;
        error?: { code?: unknown };
      };
      if (envelope.ok === false)
        throw this.errorFromFailure(parsed, result.status ?? undefined);
      if (envelope.ok === true) return envelope.data;
    }
    if (isRawJsonCommand(args)) return parsed;
    if (isNonEnvelopeCommand(args) && parsed === null) return undefined;
    throw new FeishuCliError("CLI_MALFORMED_OUTPUT");
  }

  public async configure(onOutput: FeishuCliOutputCallback): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const child = this.spawnProcess(
      ["config", "init", "--new", "--name", this.profile],
      this.stateDir,
      false,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const outputQueue = this.forwardOutput(child, onOutput);
    const result = await this.waitForProcess(
      child,
      outputQueue,
      DEFAULT_TIMEOUT_MS * 20,
    );
    if (result.status !== 0) {
      const parsed =
        tryParsedJson(result.stdout) ?? tryParsedJson(result.stderr);
      throw this.errorFromFailure(parsed, result.status ?? undefined);
    }
  }

  public async subscribe(
    callback: (event: unknown) => void | Promise<void>,
  ): Promise<FeishuCliSubscription> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const child = this.spawnProcess(
      ["event", "consume", "im.message.receive_v1"],
      this.stateDir,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let closed = false;
    let exited = false;
    let ready = false;
    let callbackQueue: Promise<void> = Promise.resolve();
    let pendingCallbacks = 0;
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (closed) return;
      stdoutBuffer += String(chunk);
      if (Buffer.byteLength(stdoutBuffer) > MAX_EVENT_LINE_BYTES) {
        closed = true;
        closeChild(child);
        return;
      }
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        if (closed) return;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          if (pendingCallbacks >= 100) {
            closed = true;
            closeChild(child);
            return;
          }
          try {
            const event = JSON.parse(line) as unknown;
            pendingCallbacks++;
            callbackQueue = callbackQueue
              .then(() => (closed ? undefined : callback(event)))
              .catch(() => undefined)
              .finally(() => {
                pendingCallbacks--;
              });
          } catch {
            // Ignore a malformed line; the official stream is NDJSON.
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    let stderrBuffer = "";
    let rejectReadyPromise: ((error: Error) => void) | undefined;
    const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      rejectReadyPromise = rejectReady;
      const onStderr = (chunk: Buffer | string) => {
        stderrBuffer += String(chunk);
        if (
          !ready &&
          /(?:^|\n)\[event\] ready event_key=im\.message\.receive_v1(?:\n|$)/.test(
            stderrBuffer,
          )
        ) {
          ready = true;
          if (readyTimer !== undefined) clearTimeout(readyTimer);
          resolveReady();
        }
        if (stderrBuffer.length > 2048)
          stderrBuffer = stderrBuffer.slice(-2048);
      };
      child.stderr.on("data", onStderr);
      child.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (!ready)
          rejectReady(
            new FeishuCliError(
              code === "ENOENT" ? "CLI_NOT_FOUND" : "CLI_EXECUTION_FAILED",
            ),
          );
      });
      child.once("close", (status) => {
        closed = true;
        exited = true;
        if (!ready)
          rejectReady(this.errorFromFailure(null, status ?? undefined));
      });
    });
    const readyTimer = setTimeout(() => {
      if (!ready) {
        rejectReadyPromise?.(new FeishuCliError("CLI_TIMEOUT"));
        closeChild(child);
      }
    }, SUBSCRIBE_TIMEOUT_MS);
    try {
      await readyPromise;
      return {
        isOpen: () => !closed && !exited,
        close: () => {
          if (closed) return;
          closed = true;
          clearTimeout(readyTimer);
          closeChild(child);
        },
      };
    } catch (error) {
      clearTimeout(readyTimer);
      closed = true;
      closeChild(child);
      throw error;
    }
  }

  public async removeProfile(): Promise<void> {
    const profiles = await this.run(["profile", "list"]);
    if (!Array.isArray(profiles))
      throw new FeishuCliError("CLI_PROFILE_INVALID");
    const names = profiles.flatMap((profile) => {
      if (profile !== null && typeof profile === "object") {
        const name = (profile as { name?: unknown }).name;
        return typeof name === "string" ? [name] : [];
      }
      return [];
    });
    if (names.length === 0) return;
    if (names.length !== 1 || names[0] !== this.profile)
      throw new FeishuCliError("CLI_PROFILE_UNEXPECTED");
    await this.run(["config", "remove"]);
  }

  private spawnProcess(
    args: string[],
    cwd: string,
    addDefaults = true,
  ): ChildProcessWithoutNullStreams {
    const child = spawn(
      this.binary,
      addDefaults ? appendDefaults(args, this.profile) : args,
      {
        cwd,
        env: environment(this.configDir, this.dataDir),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.once("close", () => clearCloseTimer(child));
    return child;
  }

  private async execute(
    args: string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<ProcessResult> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const child = this.spawnProcess(args, options.cwd, false);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTooLarge = false;
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) target.push(buffer);
      else if (!outputTooLarge) {
        outputTooLarge = true;
        closeChild(child);
      }
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      closeChild(child);
    }, options.timeoutMs);
    try {
      const result = await new Promise<ProcessResult>(
        (resolveResult, rejectResult) => {
          child.once("error", (error) => {
            const code = (error as NodeJS.ErrnoException).code;
            rejectResult(
              new FeishuCliError(
                code === "ENOENT" ? "CLI_NOT_FOUND" : "CLI_EXECUTION_FAILED",
              ),
            );
          });
          child.once("close", (status, signal) =>
            resolveResult({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              status,
              signal,
            }),
          );
        },
      );
      if (outputTooLarge) throw new FeishuCliError("CLI_OUTPUT_TOO_LARGE");
      if (timedOut) throw new FeishuCliError("CLI_TIMEOUT");
      if (result.signal === "SIGTERM" && options.timeoutMs > 0)
        throw new FeishuCliError("CLI_TIMEOUT");
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForProcess(
    child: ChildProcessWithoutNullStreams,
    outputQueue: { wait: () => Promise<void>; error: () => unknown },
    timeoutMs: number,
  ): Promise<ProcessResult> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTooLarge = false;
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      const buffer = Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) target.push(buffer);
      else if (!outputTooLarge) {
        outputTooLarge = true;
        closeChild(child);
      }
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      closeChild(child);
    }, timeoutMs);
    try {
      const result = await new Promise<ProcessResult>(
        (resolveResult, rejectResult) => {
          child.once("error", () =>
            rejectResult(new FeishuCliError("CLI_EXECUTION_FAILED")),
          );
          child.once("close", (status, signal) =>
            resolveResult({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              status,
              signal,
            }),
          );
        },
      );
      await outputQueue.wait();
      if (outputTooLarge) throw new FeishuCliError("CLI_OUTPUT_TOO_LARGE");
      if (timedOut) throw new FeishuCliError("CLI_TIMEOUT");
      const callbackError = outputQueue.error();
      if (callbackError !== undefined) {
        if (callbackError instanceof Error) throw callbackError;
        throw new Error("CLI_OUTPUT_CALLBACK_FAILED");
      }
      if (result.signal === "SIGTERM") throw new FeishuCliError("CLI_TIMEOUT");
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private forwardOutput(
    child: ChildProcessWithoutNullStreams,
    callback: FeishuCliOutputCallback,
  ): { wait: () => Promise<void>; error: () => unknown } {
    let queue = Promise.resolve();
    let callbackError: unknown;
    const forward = (chunk: Buffer | string) => {
      queue = queue
        .then(() => callback(String(chunk)))
        .catch((error: unknown) => {
          callbackError = error;
          closeChild(child);
        });
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    return { wait: () => queue, error: () => callbackError };
  }

  private errorFromFailure(
    parsed: unknown,
    status: number | undefined,
  ): FeishuCliError {
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const error = (
        parsed as {
          error?: {
            code?: unknown;
            subtype?: unknown;
            type?: unknown;
          };
        }
      ).error;
      const numericCode =
        typeof error?.code === "number" && Number.isInteger(error.code)
          ? error.code
          : null;
      const errorType =
        typeof error?.type === "string" ? error.type.toLowerCase() : "";
      if (errorType === "network" || errorType === "transport") {
        const code = safeErrorCode(error?.subtype ?? error?.type);
        if (code !== null) return new FeishuCliError(code, status);
      }
      if (numericCode !== null && numericCode >= 500 && numericCode < 600)
        return new FeishuCliError(`CLI_HTTP_${numericCode}`, status);
      const code = safeErrorCode(error?.code ?? error?.subtype ?? error?.type);
      if (code !== null) return new FeishuCliError(code, status);
    }
    return new FeishuCliError(
      status === undefined ? "CLI_EXECUTION_FAILED" : "CLI_COMMAND_FAILED",
      status,
    );
  }
}

function closeChild(child: ChildProcessWithoutNullStreams): void {
  if (child.stdin.writable) child.stdin.end();
  if (!child.killed) child.kill("SIGTERM");
  if (!closeTimers.has(child)) {
    const timer = setTimeout(() => {
      const stillRunning =
        (child.exitCode === null || child.exitCode === undefined) &&
        (child.signalCode === null || child.signalCode === undefined);
      if (stillRunning) child.kill("SIGKILL");
      closeTimers.delete(child);
    }, 1000);
    timer.unref();
    closeTimers.set(child, timer);
  }
}

function clearCloseTimer(child: ChildProcessWithoutNullStreams): void {
  const timer = closeTimers.get(child);
  if (timer !== undefined) {
    clearTimeout(timer);
    closeTimers.delete(child);
  }
}
