import type { InboundText } from "../messaging/text-inbox.js";
import type { CodexEvent, CodexPort } from "./codex-client.js";
import {
  emptyGatewayState,
  type GatewayState,
  type GatewayStateStore,
} from "./storage.js";
import { StreamingOutput, type SendGatewayText } from "./streaming-output.js";

type ActiveTurn = {
  threadId: string;
  turnId: string;
  epoch: number;
  done: Promise<void>;
  finish: () => void;
};

type PendingStart = {
  threadId: string;
  epoch: number;
  events: CodexEvent[];
  textBytes: number;
};

export type GatewayControllerOptions = {
  codex: CodexPort;
  store: GatewayStateStore;
  send: SendGatewayText;
  onError?: (code: string) => void;
  interruptTimeoutMs?: number;
  outputIdleMs?: number;
};

/** Owns a single current thread pointer; Codex owns all conversation history. */
export class GatewayController {
  private state: GatewayState = emptyGatewayState();
  private readonly output: StreamingOutput;
  private readonly items = new Map<string, string>();
  private active: ActiveTurn | null = null;
  private pendingStart: PendingStart | null = null;
  private epoch = 0;
  private loadedThread: string | null = null;
  private connected = false;
  private unsubscribe: (() => void) | undefined;
  private tail: Promise<void> = Promise.resolve();
  private error: string | null = null;
  private recoveredUncertain = false;
  private closing = false;
  private stateLoaded = false;

  public constructor(private readonly options: GatewayControllerOptions) {
    this.output = new StreamingOutput({
      send: options.send,
      onError: (code) => this.recordError(code),
      ...(options.outputIdleMs === undefined
        ? {}
        : { idleMs: options.outputIdleMs }),
    });
  }

  public async initialize(): Promise<void> {
    this.state = await this.options.store.load();
    this.stateLoaded = true;
    if (this.state.pending.length > 0) {
      // The process could have died on either side of turn/start. Never execute it twice.
      this.state.handled = [...this.state.handled, ...this.state.pending].slice(
        -10_000,
      );
      this.state.pending = [];
      this.state.lastError = "GATEWAY_PREVIOUS_INPUT_OUTCOME_UNKNOWN";
      this.recoveredUncertain = true;
      await this.options.store.save(this.state);
    }
    this.error = this.state.lastError;
    this.unsubscribe = this.options.codex.onEvent((event) =>
      this.onEvent(event),
    );
    await this.options.codex.connect();
    this.connected = true;
  }

  public status(): {
    threadId: string | null;
    turnId: string | null;
    connected: boolean;
    lastError: string | null;
  } {
    return {
      threadId: this.state.threadId,
      turnId: this.active?.turnId ?? null,
      connected: this.connected,
      lastError: this.error,
    };
  }

  public accept(messages: readonly InboundText[]): Promise<string[]> {
    const operation = this.tail.then(() => this.consume(messages));
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.epoch = this.output.begin();
    this.unsubscribe?.();
    this.connected = false;
    this.active?.finish();
    this.active = null;
    await Promise.allSettled([this.output.close(), this.options.codex.close()]);
    await this.tail;
    this.state.lastError = this.error;
    if (this.stateLoaded) await this.options.store.save(this.state);
  }

  private async consume(messages: readonly InboundText[]): Promise<string[]> {
    if (this.closing) throw new Error("GATEWAY_CLOSED");
    const seen = new Set(this.state.handled);
    const fresh: InboundText[] = [];
    for (const message of messages) {
      if (!seen.has(message.id)) fresh.push(message);
      seen.add(message.id);
    }
    if (fresh.length === 0) return messages.map((message) => message.id);
    if (fresh.length > 50) throw new Error("GATEWAY_INPUT_BATCH_TOO_LARGE");

    const groups: InboundText[][] = [];
    for (const message of fresh) {
      if (message.text.trim() === "/newchat") groups.push([message]);
      else {
        const previous = groups.at(-1);
        if (previous === undefined || previous[0]?.text.trim() === "/newchat")
          groups.push([message]);
        else previous.push(message);
      }
    }

    for (const group of groups) {
      this.epoch = this.output.begin();
      this.items.clear();
      this.state.pending = group.map((message) => message.id);
      await this.options.store.save(this.state);
      this.error = null;
      try {
        if (!this.connected) throw new Error("GATEWAY_CODEX_DISCONNECTED");
        await this.interruptActive();
        if (group[0]?.text.trim() === "/newchat") {
          // Empty app-server threads have no persisted rollout yet. Materialize
          // the fresh thread on its first input, including after a gateway restart.
          this.state.threadId = null;
          this.loadedThread = null;
          await this.options.store.save(this.state);
          // A send already admitted by the Hub can finish; the new-chat acknowledgement follows it.
          await this.output.settled();
          this.output.append(
            this.epoch,
            "已切换到新对话。后续消息将使用空白聊天上下文。",
          );
          this.output.flush(this.epoch);
        } else {
          const threadId = await this.ensureThread();
          if (this.recoveredUncertain) {
            this.output.append(
              this.epoch,
              "上次连接中断时，有消息的处理结果未能确认，gateway 未自动重复执行。\n",
            );
            this.recoveredUncertain = false;
          }
          await this.start(
            threadId,
            group.map((message) => message.text).join("\n\n"),
          );
        }
      } catch (error) {
        if (this.closing) throw new Error("GATEWAY_CLOSED");
        const code =
          error instanceof Error &&
          /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
            ? error.message
            : "GATEWAY_CODEX_REQUEST_FAILED";
        this.recordError(code);
        this.output.append(
          this.epoch,
          "这条消息的处理未能确认，gateway 不会自动重复执行。请查看 gateway status；需要空白会话时发送 /newchat。",
        );
        this.output.flush(this.epoch);
      }
      this.state.handled = [...this.state.handled, ...this.state.pending].slice(
        -10_000,
      );
      this.state.pending = [];
      this.state.lastError = this.error;
      await this.options.store.save(this.state);
    }
    return messages.map((message) => message.id);
  }

  private async ensureThread(): Promise<string> {
    if (this.state.threadId === null) {
      this.state.threadId = await this.options.codex.createThread();
      this.loadedThread = this.state.threadId;
      await this.options.store.save(this.state);
    } else if (this.loadedThread !== this.state.threadId) {
      await this.options.codex.resumeThread(this.state.threadId);
      this.loadedThread = this.state.threadId;
    }
    return this.state.threadId;
  }

  private async start(threadId: string, text: string): Promise<void> {
    const pending: PendingStart = {
      threadId,
      epoch: this.epoch,
      events: [],
      textBytes: 0,
    };
    this.pendingStart = pending;
    try {
      const turnId = await this.options.codex.startTurn(threadId, text);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.active = { threadId, turnId, epoch: pending.epoch, done, finish };
      this.pendingStart = null;
      for (const event of pending.events) this.onEvent(event);
    } finally {
      this.pendingStart = null;
    }
  }

  private async interruptActive(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    try {
      await this.options.codex.interruptTurn(active.threadId, active.turnId);
    } catch (error) {
      if (this.active === active) throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("GATEWAY_INTERRUPT_TIMEOUT")),
            this.options.interruptTimeoutMs ?? 15_000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!this.connected) throw new Error("GATEWAY_CODEX_DISCONNECTED");
  }

  private onEvent(event: CodexEvent): void {
    if (event.type === "disconnected") {
      this.connected = false;
      this.active?.finish();
      this.active = null;
      this.recordError("GATEWAY_CODEX_DISCONNECTED");
      return;
    }
    if (event.type === "notice") {
      if (event.threadId !== undefined) {
        const pending = this.pendingStart;
        const active = this.active;
        const currentPending =
          pending !== null &&
          pending.threadId === event.threadId &&
          pending.epoch === this.epoch;
        const currentActive =
          active !== null &&
          active.threadId === event.threadId &&
          active.epoch === this.epoch &&
          (event.turnId === undefined || event.turnId === active.turnId);
        if (!currentPending && !currentActive) return;
      }
      this.output.append(this.epoch, `${event.text}\n`);
      this.output.flush(this.epoch);
      return;
    }
    const pending = this.pendingStart;
    if (pending !== null && event.threadId === pending.threadId) {
      pending.textBytes += "text" in event ? event.text.length : 0;
      if (pending.textBytes > 1024 * 1024 || pending.events.length >= 10_000) {
        this.recordError("GATEWAY_CODEX_EVENT_OVERFLOW");
        return;
      }
      pending.events.push(event);
      return;
    }
    const active = this.active;
    if (
      active === null ||
      event.threadId !== active.threadId ||
      event.turnId !== active.turnId
    )
      return;
    if (event.type === "turn-completed") {
      if (active.epoch === this.epoch) {
        if (event.status === "failed") {
          this.output.append(this.epoch, "\nCodex 执行失败，请检查当前会话。");
          this.recordError("GATEWAY_TURN_FAILED");
        }
        this.output.flush(active.epoch);
      }
      active.finish();
      this.active = null;
      return;
    }
    if (active.epoch !== this.epoch) return;
    const previous = this.items.get(event.itemId) ?? "";
    if (event.type === "delta") {
      if (previous.length + event.text.length > 1024 * 1024) {
        this.recordError("GATEWAY_CODEX_MESSAGE_TOO_LARGE");
        return;
      }
      this.items.set(event.itemId, previous + event.text);
      this.output.append(active.epoch, event.text);
    } else {
      // Completed items repeat their full text; only a missing suffix is new output.
      if (event.text.startsWith(previous))
        this.output.append(active.epoch, event.text.slice(previous.length));
      this.items.set(event.itemId, event.text);
      this.output.append(active.epoch, "\n");
    }
  }

  private recordError(code: string): void {
    this.error = code;
    this.options.onError?.(code);
  }
}
