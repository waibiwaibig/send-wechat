import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { APP_VERSION } from "../app/version.js";

export type CodexEvent =
  | {
      type: "delta";
      threadId: string;
      turnId: string;
      itemId: string;
      text: string;
    }
  | {
      type: "message-completed";
      threadId: string;
      turnId: string;
      itemId: string;
      text: string;
    }
  | {
      type: "turn-completed";
      threadId: string;
      turnId: string;
      status: string;
    }
  | { type: "notice"; text: string; threadId?: string; turnId?: string }
  | { type: "disconnected" };

export interface CodexPort {
  connect(): Promise<void>;
  createThread(): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  startTurn(threadId: string, text: string): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  onEvent(listener: (event: CodexEvent) => void): () => void;
  close(): Promise<void>;
}

export type CodexAppServerOptions = {
  executable: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
};

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

type PendingRequest = {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

const DEFAULT_ARGS = ["app-server", "--stdio"];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDOUT_FRAME_BYTES = 1_048_576;
const DISCONNECTED_ERROR = "Codex app-server disconnected";
const METHOD_NOT_FOUND = -32601;
const SERVER_REQUEST_ERROR = -32000;

const APPROVAL_METHODS = new Map<string, JsonObject>([
  ["item/commandExecution/requestApproval", { decision: "decline" }],
  ["item/fileChange/requestApproval", { decision: "decline" }],
  [
    "item/permissions/requestApproval",
    {
      permissions: { fileSystem: null, network: null },
      scope: "turn",
    },
  ],
  ["item/tool/requestUserInput", { answers: {} }],
  ["mcpServer/elicitation/request", { action: "decline" }],
]);

const DYNAMIC_TOOL_METHOD = "item/tool/call";
const KNOWN_UNFULFILLABLE_METHODS = new Set([
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
]);

export class CodexAppServer implements CodexPort {
  private readonly executable: string;
  private readonly cwd: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: "idle" | "connecting" | "connected" | "closing" | "closed" =
    "idle";
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly listeners = new Set<(event: CodexEvent) => void>();
  private stdoutBuffer = "";
  private disconnectedNotified = false;

  constructor(options: CodexAppServerOptions) {
    this.executable = options.executable;
    this.cwd = options.cwd;
    this.args = options.args ? [...options.args] : [...DEFAULT_ARGS];
    this.env = options.env ?? process.env;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive finite number");
    }
  }

  async connect(): Promise<void> {
    if (this.state === "connected") return;
    if (this.connectPromise) return this.connectPromise;
    if (this.state === "closed" || this.state === "closing") {
      throw new Error(DISCONNECTED_ERROR);
    }

    this.state = "connecting";
    const promise = this.openAndInitialize().finally(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    });
    this.connectPromise = promise;
    return promise;
  }

  async createThread(): Promise<string> {
    const result = await this.request("thread/start", { cwd: this.cwd });
    const thread = getObject(result, "thread");
    const threadId = getString(thread, "id");
    if (!threadId)
      throw new Error("Codex thread/start response has no thread id");
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    const turn = getObject(result, "turn");
    const turnId = getString(turn, "id");
    if (!turnId) throw new Error("Codex turn/start response has no turn id");
    return turnId;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  onEvent(listener: (event: CodexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.child) {
      this.state = "closed";
      this.rejectPending(new Error(DISCONNECTED_ERROR));
      this.emitDisconnected();
      return;
    }

    this.state = "closing";
    const child = this.child;
    this.rejectPending(new Error(DISCONNECTED_ERROR));
    this.emitDisconnected();
    this.closePromise = new Promise<void>((resolve) => {
      let settled = false;
      const timers: {
        terminate?: NodeJS.Timeout;
        forceKill?: NodeJS.Timeout;
        finalWait?: NodeJS.Timeout;
      } = {};
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timers.terminate) clearTimeout(timers.terminate);
        if (timers.forceKill) clearTimeout(timers.forceKill);
        if (timers.finalWait) clearTimeout(timers.finalWait);
        resolve();
      };
      child.once("close", finish);
      child.once("error", finish);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      try {
        child.stdin.end();
      } catch {
        finish();
      }
      const terminateTimerHandle = setTimeout(
        () => {
          if (!settled) {
            try {
              child.kill("SIGTERM");
            } catch {
              finish();
              return;
            }
            timers.forceKill = setTimeout(() => {
              if (settled) return;
              try {
                child.kill("SIGKILL");
              } finally {
                // Give the child a bounded opportunity to report `close`. If a
                // platform does not deliver it, the adapter still cannot wait
                // forever on an already disconnected stdin/stdout pair.
                timers.finalWait = setTimeout(finish, 500);
                timers.finalWait.unref();
              }
            }, 500);
            timers.forceKill.unref();
          }
        },
        Math.min(this.requestTimeoutMs, 2_000),
      );
      timers.terminate = terminateTimerHandle;
      terminateTimerHandle.unref();
    }).finally(() => {
      this.state = "closed";
      this.child = null;
      this.closePromise = null;
    });
    return this.closePromise;
  }

  private async openAndInitialize(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executable, this.args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.failClosed(asError(error));
      throw asError(error);
    }

    this.child = child;
    this.attachChild(child);
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "send-wechat-gateway",
          title: "send-wechat Codex gateway",
          version: APP_VERSION,
        },
      });
      this.sendNotification("initialized");
      this.state = "connected";
    } catch (error) {
      this.failClosed(asError(error));
      throw asError(error);
    }
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      this.consumeStdout(
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    });
    // The gateway deliberately consumes stderr without forwarding or logging it.
    child.stderr.resume();
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.failClosed(error));
    child.on("close", () => {
      if (this.child === child) this.failClosed(new Error(DISCONNECTED_ERROR));
    });
    child.stdin.on("error", (error) => this.failClosed(error));
  }

  private consumeStdout(chunk: string): void {
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        if (this.stdoutBuffer.length + rest.length > MAX_STDOUT_FRAME_BYTES) {
          this.failClosed(
            new Error("Codex app-server frame exceeds the size limit"),
          );
          return;
        }
        this.stdoutBuffer += rest;
        return;
      }

      const line = rest.slice(0, newline);
      if (this.stdoutBuffer.length + line.length > MAX_STDOUT_FRAME_BYTES) {
        this.failClosed(
          new Error("Codex app-server frame exceeds the size limit"),
        );
        return;
      }
      this.stdoutBuffer += line;
      rest = rest.slice(newline + 1);
      const frame = this.stdoutBuffer.endsWith("\r")
        ? this.stdoutBuffer.slice(0, -1)
        : this.stdoutBuffer;
      this.stdoutBuffer = "";
      if (frame.length > 0) this.handleFrame(frame);
      if (this.state === "closed") return;
    }
  }

  private handleFrame(frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      this.failClosed(new Error("Codex app-server sent invalid JSON"));
      return;
    }
    if (!isObject(message) || Array.isArray(message)) {
      this.failClosed(
        new Error("Codex app-server sent an invalid JSON-RPC frame"),
      );
      return;
    }

    const id = getId(message.id);
    const method = getString(message, "method");
    if (method) {
      if (id !== undefined) {
        void this.handleServerRequest(id, method, message.params);
      } else {
        this.handleNotification(method, message.params);
      }
      return;
    }

    if (id !== undefined && ("result" in message || "error" in message)) {
      this.handleResponse(id, message);
      return;
    }
    this.failClosed(
      new Error("Codex app-server sent an invalid JSON-RPC message"),
    );
  }

  private handleResponse(id: JsonRpcId, message: JsonObject): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = isObject(message.error) ? message.error : undefined;
    if (error) {
      const code = typeof error.code === "number" ? ` (${error.code})` : "";
      const text =
        typeof error.message === "string" ? error.message : "JSON-RPC error";
      pending.reject(new Error(`${pending.method}${code}: ${text}`));
      return;
    }
    pending.resolve(message.result);
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = isObject(rawParams) ? rawParams : {};
    if (method === "item/agentMessage/delta") {
      const event = parseMessageDelta(params);
      if (!event) {
        this.failClosed(
          new Error("Codex agent message delta has invalid params"),
        );
        return;
      }
      this.emit(event);
      return;
    }
    if (method === "item/completed") {
      const event = parseMessageCompleted(params);
      if (event) this.emit(event);
      return;
    }
    if (method === "turn/completed") {
      const event = parseTurnCompleted(params);
      if (!event) {
        this.failClosed(new Error("Codex turn completion has invalid params"));
        return;
      }
      this.emit(event);
    }
  }

  private handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): void {
    const context = isObject(params) ? params : {};
    if (APPROVAL_METHODS.has(method)) {
      this.emitNotice(
        "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
        context,
      );
      this.sendResponse(id, APPROVAL_METHODS.get(method) as JsonObject);
      return;
    }
    if (method === DYNAMIC_TOOL_METHOD) {
      this.emitNotice(
        "Codex请求了gateway暂不支持的交互，本次请求已拒绝。",
        context,
      );
      this.sendResponse(id, { success: false, contentItems: [] });
      return;
    }
    if (KNOWN_UNFULFILLABLE_METHODS.has(method)) {
      this.emitNotice(
        "Codex请求了gateway暂不支持的交互，本次请求已拒绝。",
        context,
      );
      this.sendError(
        id,
        SERVER_REQUEST_ERROR,
        `Unsupported server request: ${method}`,
      );
      return;
    }

    this.sendError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  private emitNotice(text: string, context: JsonObject): void {
    const threadId = getString(context, "threadId");
    const turnId = getString(context, "turnId");
    this.emit({
      type: "notice",
      text,
      ...(threadId === undefined ? {} : { threadId }),
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.child || this.state === "closed" || this.state === "closing") {
      return Promise.reject(new Error(DISCONNECTED_ERROR));
    }
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failClosed(new Error(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { method, timer, resolve, reject });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(asError(error));
        this.failClosed(asError(error));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private sendResponse(id: JsonRpcId, result: JsonObject): void {
    try {
      this.write({ id, result });
    } catch (error) {
      this.failClosed(asError(error));
    }
  }

  private sendError(id: JsonRpcId, code: number, message: string): void {
    try {
      this.write({ id, error: { code, message } });
    } catch (error) {
      this.failClosed(asError(error));
    }
  }

  private write(message: JsonObject): void {
    if (!this.child || this.child.stdin.destroyed || this.state === "closed") {
      throw new Error(DISCONNECTED_ERROR);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failClosed(error: Error): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.stdoutBuffer = "";
    this.rejectPending(error);
    this.emitDisconnected();
    const child = this.child;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // The process may have exited between the state check and kill().
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emit(event: CodexEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A consumer listener must not break the stdio protocol loop.
      }
    }
  }

  private emitDisconnected(): void {
    if (this.disconnectedNotified) return;
    this.disconnectedNotified = true;
    this.emit({ type: "disconnected" });
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getObject(value: unknown, key: string): JsonObject {
  if (!isObject(value) || !isObject(value[key])) {
    throw new Error(`Expected object field ${key}`);
  }
  return value[key];
}

function getString(value: unknown, key: string): string | undefined {
  if (!isObject(value) || typeof value[key] !== "string") return undefined;
  return value[key];
}

function getId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function parseMessageDelta(params: JsonObject): CodexEvent | null {
  const threadId = getString(params, "threadId");
  const turnId = getString(params, "turnId");
  const itemId = getString(params, "itemId");
  const text = getString(params, "delta");
  if (!threadId || !turnId || !itemId || text === undefined) return null;
  return { type: "delta", threadId, turnId, itemId, text };
}

function parseMessageCompleted(params: JsonObject): CodexEvent | null {
  const threadId = getString(params, "threadId");
  const turnId = getString(params, "turnId");
  const item = isObject(params.item) ? params.item : null;
  if (!threadId || !turnId || !item || item.type !== "agentMessage")
    return null;
  const itemId = getString(item, "id");
  const text = getString(item, "text");
  if (!itemId || text === undefined) return null;
  return { type: "message-completed", threadId, turnId, itemId, text };
}

function parseTurnCompleted(params: JsonObject): CodexEvent | null {
  const threadId = getString(params, "threadId");
  const turn = isObject(params.turn) ? params.turn : null;
  if (!threadId || !turn) return null;
  const turnId = getString(turn, "id");
  const status = getString(turn, "status");
  if (!turnId || !status) return null;
  return { type: "turn-completed", threadId, turnId, status };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
