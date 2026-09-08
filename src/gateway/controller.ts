import type { InboundText } from "../messaging/text-inbox.js";
import type {
  CodexEvent,
  CodexPort,
  ModelSelection,
  GatewayPermission,
} from "./codex-client.js";
import {
  COMMAND_HELP,
  PERMISSION_LABELS,
  describeSelection,
  modelMenu,
  parseGatewayCommand,
  permissionMenu,
  selectModel,
  streamMenu,
  STREAM_LABELS,
  type GatewayCommand,
} from "./commands.js";
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
  private sendTail: Promise<void> = Promise.resolve();

  private readonly send: SendGatewayText = (text, key) => {
    const operation = this.sendTail.then(() => this.options.send(text, key));
    this.sendTail = operation.catch(() => undefined);
    return operation;
  };

  public constructor(private readonly options: GatewayControllerOptions) {
    this.output = new StreamingOutput({
      send: this.send,
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
    await this.sendTail;
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
      if (parseGatewayCommand(message.text) !== null) groups.push([message]);
      else {
        const previous = groups.at(-1);
        if (
          previous === undefined ||
          parseGatewayCommand(previous[0]!.text) !== null
        )
          groups.push([message]);
        else previous.push(message);
      }
    }

    for (const group of groups) {
      const command = parseGatewayCommand(group[0]!.text);
      this.state.pending = group.map((message) => message.id);
      await this.options.store.save(this.state);
      this.error = null;
      try {
        if (!this.connected) throw new Error("GATEWAY_CODEX_DISCONNECTED");
        if (command !== null && command.type !== "newchat") {
          await this.command(command);
        } else {
          this.epoch = this.output.begin(this.streamEnabled());
          this.items.clear();
          await this.interruptActive();
          if (command?.type === "newchat") {
            const selection = await this.selection();
            // Empty app-server threads have no persisted rollout yet. Materialize
            // the fresh thread on its first input, including after a gateway restart.
            this.state.threadId = null;
            this.loadedThread = null;
            await this.options.store.save(this.state);
            // A send already admitted by the Hub can finish; the new-chat acknowledgement follows it.
            await this.output.settled();
            await this.reply(
              `已切换到新对话。\n当前模型：${describeSelection(selection)}\n当前权限：${PERMISSION_LABELS[this.permission()]}\n当前流式发送：${this.streamEnabled() ? STREAM_LABELS.on : STREAM_LABELS.off}\n发送 / 查看命令。`,
            );
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
        }
      } catch (error) {
        if (this.closing) throw new Error("GATEWAY_CLOSED");
        const code =
          error instanceof Error &&
          /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
            ? error.message
            : "GATEWAY_CODEX_REQUEST_FAILED";
        this.recordError(code);
        await this.reply(
          "这条消息的处理未能确认，gateway 不会自动重复执行。请查看 gateway status；需要空白会话时发送 /newchat。",
        );
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
    const selection = await this.selection();
    if (this.state.threadId === null) {
      this.state.threadId = await this.options.codex.createThread(
        selection,
        this.permission(),
      );
      this.loadedThread = this.state.threadId;
      await this.options.store.save(this.state);
    } else if (this.loadedThread !== this.state.threadId) {
      await this.options.codex.resumeThread(this.state.threadId);
      this.loadedThread = this.state.threadId;
    }
    return this.state.threadId;
  }

  private permission(): GatewayPermission {
    return this.state.permission ?? "full";
  }

  private streamEnabled(): boolean {
    return this.state.streamEnabled ?? true;
  }

  private async selection(): Promise<ModelSelection> {
    if (this.state.selection !== undefined) return this.state.selection;
    if (this.state.threadId !== null) {
      this.state.selection = await this.options.codex.resumeThread(
        this.state.threadId,
      );
      this.loadedThread = this.state.threadId;
    } else {
      this.state.selection = await this.options.codex.getDefaultSelection();
    }
    await this.options.store.save(this.state);
    return this.state.selection;
  }

  private async command(
    command: Exclude<GatewayCommand, { type: "newchat" }>,
  ): Promise<void> {
    if (command.type === "help") return this.reply(COMMAND_HELP);
    if (command.type === "unknown")
      return this.reply(
        `未识别命令 ${command.name.slice(0, 80)}。\n${COMMAND_HELP}`,
      );
    if (command.type === "permission") {
      if (command.args.length === 0)
        return this.reply(permissionMenu(this.permission()));
      const value = command.args[0];
      if (
        command.args.length !== 1 ||
        (value !== "full" && value !== "workspace" && value !== "read-only")
      )
        return this.reply(
          `权限选项无效。\n${permissionMenu(this.permission())}`,
        );
      this.epoch = this.output.begin();
      this.items.clear();
      await this.interruptActive();
      this.state.permission = value;
      await this.options.store.save(this.state);
      await this.output.settled();
      return this.reply(
        `当前权限：${PERMISSION_LABELS[value]}。后续输入使用此权限，/newchat 后保留。`,
      );
    }
    if (command.type === "stream") {
      if (command.args.length === 0)
        return this.reply(streamMenu(this.streamEnabled()));
      if (
        command.args.length !== 1 ||
        (command.args[0] !== "on" && command.args[0] !== "off")
      )
        return this.reply(
          `流式发送选项无效。\n${streamMenu(this.streamEnabled())}`,
        );
      this.state.streamEnabled = command.args[0] === "on";
      await this.options.store.save(this.state);
      return this.reply(
        `已${this.state.streamEnabled ? "开启" : "关闭"}流式发送。下一次回复生效，当前回复继续沿用开始时的设置。`,
      );
    }
    const models = await this.options.codex.listModels();
    if (command.args.length === 0)
      return this.reply(modelMenu(await this.selection(), models));
    const result = selectModel(command.args, models);
    if ("error" in result) return this.reply(result.error);
    this.state.selection = result.selection;
    await this.options.store.save(this.state);
    return this.reply(
      `已选择模型：${describeSelection(result.selection)}。下一次回复生效，/newchat 后保留。`,
    );
  }

  private async reply(text: string): Promise<void> {
    const output = new StreamingOutput({
      send: this.send,
      onError: (code) => this.recordError(code),
      minChars: 4000,
      maxChars: 4000,
    });
    const epoch = output.begin();
    output.append(epoch, text);
    output.flush(epoch);
    await output.settled();
    await output.close();
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
      const turnId = await this.options.codex.startTurn(
        threadId,
        text,
        await this.selection(),
        this.permission(),
      );
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
      void this.reply(`${event.text}\n`);
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
      this.output.flush(active.epoch);
    }
  }

  private recordError(code: string): void {
    this.error = code;
    this.options.onError?.(code);
  }
}
