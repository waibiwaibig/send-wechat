import { afterEach, describe, expect, it } from "vitest";

import { GatewayController } from "../src/gateway/controller.js";
import type { CodexEvent, CodexPort } from "../src/gateway/codex-client.js";
import {
  emptyGatewayState,
  type GatewayState,
  type GatewayStateStore,
} from "../src/gateway/storage.js";
import type { InboundText } from "../src/messaging/text-inbox.js";

type StartCall = {
  threadId: string;
  text: string;
  turnId: string;
};

class MemoryGatewayStateStore implements GatewayStateStore {
  public readonly saves: GatewayState[] = [];
  private state: GatewayState;

  public constructor(initial: GatewayState = emptyGatewayState()) {
    this.state = clone(initial);
  }

  public async load(): Promise<GatewayState> {
    return clone(this.state);
  }

  public async save(state: GatewayState): Promise<void> {
    this.state = clone(state);
    this.saves.push(clone(state));
  }

  public snapshot(): GatewayState {
    return clone(this.state);
  }
}

class FakeCodexPort implements CodexPort {
  public readonly createdThreads: string[] = [];
  public readonly resumedThreads: string[] = [];
  public readonly startCalls: StartCall[] = [];
  public readonly interruptCalls: Array<{ threadId: string; turnId: string }> =
    [];
  public autoCompleteInterrupt = false;

  private readonly listeners = new Set<(event: CodexEvent) => void>();
  private nextThreadNumber: number;
  private pendingStart:
    | {
        resolve: (turnId: string) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private nextStartError: Error | undefined;

  public constructor(startingThreadNumber = 1) {
    this.nextThreadNumber = startingThreadNumber;
  }

  public async connect(): Promise<void> {}

  public async close(): Promise<void> {}

  public async createThread(): Promise<string> {
    const threadId = `thread-${this.nextThreadNumber}`;
    this.nextThreadNumber += 1;
    this.createdThreads.push(threadId);
    return threadId;
  }

  public async resumeThread(threadId: string): Promise<void> {
    this.resumedThreads.push(threadId);
  }

  public startTurn(threadId: string, text: string): Promise<string> {
    const turnId = `turn-${this.startCalls.length + 1}`;
    this.startCalls.push({ threadId, text, turnId });
    if (this.nextStartError !== undefined) {
      const error = this.nextStartError;
      this.nextStartError = undefined;
      return Promise.reject(error);
    }
    if (this.pendingStart !== undefined) {
      throw new Error("only one deferred start is supported");
    }
    if (!this.startDeferred) return Promise.resolve(turnId);
    this.startDeferred = false;
    return new Promise<string>((resolve, reject) => {
      this.pendingStart = { resolve, reject };
    });
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interruptCalls.push({ threadId, turnId });
    if (this.autoCompleteInterrupt) {
      this.emit({
        type: "turn-completed",
        threadId,
        turnId,
        status: "interrupted",
      });
    }
  }

  public onEvent(listener: (event: CodexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public deferNextStart(): void {
    if (this.startDeferred) throw new Error("start already deferred");
    this.startDeferred = true;
  }

  public rejectNextStart(error: Error): void {
    this.nextStartError = error;
  }

  public resolveDeferredStart(turnId: string): void {
    const pending = this.pendingStart;
    if (pending === undefined) throw new Error("no deferred start");
    this.pendingStart = undefined;
    pending.resolve(turnId);
  }

  public rejectDeferredStart(error: Error): void {
    const pending = this.pendingStart;
    if (pending === undefined) throw new Error("no deferred start");
    this.pendingStart = undefined;
    pending.reject(error);
  }

  public emit(event: CodexEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private startDeferred = false;
}

const controllers: GatewayController[] = [];

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.close()),
  );
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function message(id: string, text: string): InboundText {
  return { id, text, receivedAt: 1 };
}

function makeHarness(
  initial?: GatewayState,
  startingThreadNumber = 1,
): {
  controller: GatewayController;
  codex: FakeCodexPort;
  store: MemoryGatewayStateStore;
  sent: Array<{ text: string; idempotencyKey: string }>;
  errors: string[];
} {
  const codex = new FakeCodexPort(startingThreadNumber);
  const store = new MemoryGatewayStateStore(initial);
  const sent: Array<{ text: string; idempotencyKey: string }> = [];
  const errors: string[] = [];
  const controller = new GatewayController({
    codex,
    store,
    send: async (text, idempotencyKey) => {
      sent.push({ text, idempotencyKey });
    },
    onError: (code) => errors.push(code),
    interruptTimeoutMs: 100,
    outputIdleMs: 10,
  });
  controllers.push(controller);
  return { controller, codex, store, sent, errors };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error("test condition was not reached");
}

async function finishTurn(
  codex: FakeCodexPort,
  call: StartCall,
  text: string,
): Promise<void> {
  const itemId = `item-${call.turnId}`;
  codex.emit({
    type: "delta",
    threadId: call.threadId,
    turnId: call.turnId,
    itemId,
    text,
  });
  codex.emit({
    type: "message-completed",
    threadId: call.threadId,
    turnId: call.turnId,
    itemId,
    text,
  });
  codex.emit({
    type: "turn-completed",
    threadId: call.threadId,
    turnId: call.turnId,
    status: "completed",
  });
  await tick();
}

describe("GatewayController", () => {
  it("creates once, reuses and resumes the thread, then starts a blank new chat", async () => {
    const first = makeHarness();
    await first.controller.initialize();

    await first.controller.accept([message("m1", "first")]);
    expect(first.codex.createdThreads).toEqual(["thread-1"]);
    expect(first.codex.startCalls).toEqual([
      { threadId: "thread-1", text: "first", turnId: "turn-1" },
    ]);
    await finishTurn(first.codex, first.codex.startCalls[0]!, "reply one");

    await first.controller.accept([message("m2", "second")]);
    expect(first.codex.resumedThreads).toEqual([]);
    expect(first.codex.startCalls[1]).toMatchObject({
      threadId: "thread-1",
      text: "second",
    });
    await finishTurn(first.codex, first.codex.startCalls[1]!, "reply two");

    const saved = first.store.snapshot();
    expect(saved.threadId).toBe("thread-1");
    await first.controller.close();

    const restarted = makeHarness(saved, 2);
    await restarted.controller.initialize();
    await restarted.controller.accept([message("m3", "after restart")]);
    expect(restarted.codex.resumedThreads).toEqual(["thread-1"]);
    expect(restarted.codex.startCalls[0]).toMatchObject({
      threadId: "thread-1",
      text: "after restart",
    });
    await finishTurn(
      restarted.codex,
      restarted.codex.startCalls[0]!,
      "reply three",
    );

    await restarted.controller.accept([message("m4", "/newchat")]);
    expect(restarted.codex.createdThreads).toEqual([]);
    expect(restarted.sent.at(-1)?.text).toContain("已切换到新对话");

    await restarted.controller.accept([message("m5", "blank context")]);
    expect(restarted.codex.createdThreads).toEqual(["thread-2"]);
    expect(restarted.codex.startCalls[1]).toMatchObject({
      threadId: "thread-2",
      text: "blank context",
    });
    expect(restarted.codex.startCalls[1]?.text).not.toContain("after restart");
  });

  it("interrupts every active turn and waits for its completion before starting the next input", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([message("m1", "first")]);

    const next = harness.controller.accept([message("m2", "second")]);
    await waitFor(() => harness.codex.interruptCalls.length === 1);
    expect(harness.codex.startCalls).toHaveLength(1);

    harness.codex.emit({
      type: "turn-completed",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "interrupted",
    });
    await waitFor(() => harness.codex.startCalls.length === 2);
    await next;
    expect(harness.codex.startCalls[1]).toMatchObject({
      threadId: "thread-1",
      text: "second",
    });
  });

  it("does not start the next turn after an interrupt timeout", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([message("m1", "first")]);

    const next = harness.controller.accept([message("m2", "second")]);
    await waitFor(() => harness.codex.interruptCalls.length === 1);
    await expect(next).resolves.toEqual(["m2"]);

    expect(harness.codex.startCalls).toHaveLength(1);
    expect(harness.errors).toContain("GATEWAY_INTERRUPT_TIMEOUT");
    expect(harness.store.snapshot().handled).toContain("m2");
  });

  it("preserves input admitted during a concurrent close for uncertain recovery", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([message("m1", "first")]);

    const next = harness.controller.accept([message("m2", "second")]);
    await waitFor(() => harness.codex.interruptCalls.length === 1);
    const closing = harness.controller.close();

    await expect(next).rejects.toThrow("GATEWAY_CLOSED");
    await expect(closing).resolves.toBeUndefined();
    expect(harness.store.snapshot().pending).toEqual(["m2"]);

    const restarted = makeHarness(harness.store.snapshot(), 2);
    await restarted.controller.initialize();
    await restarted.controller.accept([message("m3", "fresh input")]);
    expect(restarted.codex.startCalls[0]).toMatchObject({
      threadId: "thread-1",
      text: "fresh input",
    });
    expect(restarted.codex.startCalls[0]?.text).not.toContain("second");
    await finishTurn(restarted.codex, restarted.codex.startCalls[0]!, "reply");
    expect(restarted.sent.map(({ text }) => text).join("\n")).toContain(
      "上次连接中断时",
    );
  });

  it("drops a late delta from an interrupted turn", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([message("m1", "first")]);

    const next = harness.controller.accept([message("m2", "second")]);
    await waitFor(() => harness.codex.interruptCalls.length === 1);
    harness.codex.emit({
      type: "turn-completed",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "interrupted",
    });
    await waitFor(() => harness.codex.startCalls.length === 2);
    await next;

    harness.codex.emit({
      type: "delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "old-item",
      text: "late old text",
    });
    await finishTurn(harness.codex, harness.codex.startCalls[1]!, "new text");
    expect(harness.sent.map(({ text }) => text).join("\n")).not.toContain(
      "late old text",
    );
    expect(harness.sent.map(({ text }) => text).join("\n")).toContain(
      "new text",
    );
  });

  it("keeps events received before startTurn returns", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    harness.codex.deferNextStart();

    const accepted = harness.controller.accept([message("m1", "hello")]);
    await waitFor(() => harness.codex.startCalls.length === 1);
    const call = harness.codex.startCalls[0]!;
    harness.codex.emit({
      type: "delta",
      threadId: call.threadId,
      turnId: "turn-before-response",
      itemId: "item-before-response",
      text: "queued reply",
    });
    harness.codex.emit({
      type: "message-completed",
      threadId: call.threadId,
      turnId: "turn-before-response",
      itemId: "item-before-response",
      text: "queued reply",
    });
    harness.codex.emit({
      type: "turn-completed",
      threadId: call.threadId,
      turnId: "turn-before-response",
      status: "completed",
    });
    harness.codex.resolveDeferredStart("turn-before-response");
    await accepted;
    await tick();

    expect(harness.sent.map(({ text }) => text).join("\n")).toContain(
      "queued reply",
    );
  });

  it("does not duplicate text when a delta is followed by the completed item", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([message("m1", "hello")]);
    const call = harness.codex.startCalls[0]!;
    harness.codex.emit({
      type: "delta",
      threadId: call.threadId,
      turnId: call.turnId,
      itemId: "item-1",
      text: "hello",
    });
    harness.codex.emit({
      type: "message-completed",
      threadId: call.threadId,
      turnId: call.turnId,
      itemId: "item-1",
      text: "hello",
    });
    harness.codex.emit({
      type: "turn-completed",
      threadId: call.threadId,
      turnId: call.turnId,
      status: "completed",
    });
    await tick();

    expect(harness.sent.map(({ text }) => text)).toEqual(["hello\n"]);
  });

  it("discards stale notices and forwards notices for the active turn", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([message("m1", "hello")]);
    const call = harness.codex.startCalls[0]!;

    harness.codex.emit({
      type: "notice",
      threadId: "stale-thread",
      text: "stale thread notice",
    });
    harness.codex.emit({
      type: "notice",
      threadId: call.threadId,
      turnId: "stale-turn",
      text: "stale turn notice",
    });
    harness.codex.emit({
      type: "notice",
      threadId: call.threadId,
      turnId: call.turnId,
      text: "active notice",
    });
    await waitFor(() =>
      harness.sent.some(({ text }) => text.includes("active notice")),
    );

    const output = harness.sent.map(({ text }) => text).join("\n");
    expect(output).toContain("active notice");
    expect(output).not.toContain("stale thread notice");
    expect(output).not.toContain("stale turn notice");
  });

  it("deduplicates repeated messages and never replays recovered pending input", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([
      message("duplicate", "once"),
      message("duplicate", "once again"),
    ]);
    expect(harness.codex.startCalls).toHaveLength(1);
    expect(harness.codex.startCalls[0]?.text).toBe("once");
    await finishTurn(harness.codex, harness.codex.startCalls[0]!, "done");
    await harness.controller.accept([message("duplicate", "retry")]);
    expect(harness.codex.startCalls).toHaveLength(1);

    const recovered = makeHarness({
      schemaVersion: 1,
      threadId: "thread-recovered",
      handled: [],
      pending: ["uncertain"],
      lastError: null,
    });
    await recovered.controller.initialize();
    expect(recovered.store.snapshot()).toMatchObject({
      handled: ["uncertain"],
      pending: [],
      lastError: "GATEWAY_PREVIOUS_INPUT_OUTCOME_UNKNOWN",
    });
    await recovered.controller.accept([message("uncertain", "do not replay")]);
    expect(recovered.codex.startCalls).toHaveLength(0);
  });

  it("records an unknown start failure and does not automatically retry it", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    harness.codex.rejectNextStart(new Error("GATEWAY_START_OUTCOME_UNKNOWN"));

    await harness.controller.accept([message("unknown", "once only")]);
    expect(harness.codex.startCalls).toHaveLength(1);
    expect(harness.errors).toContain("GATEWAY_START_OUTCOME_UNKNOWN");
    await harness.controller.accept([message("unknown", "retry forbidden")]);
    expect(harness.codex.startCalls).toHaveLength(1);
  });

  it("normalizes unexpected start failures and records failed turns safely", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    harness.codex.rejectNextStart(new Error("secret filesystem path"));

    await harness.controller.accept([message("bad", "will fail")]);
    expect(harness.errors).toContain("GATEWAY_CODEX_REQUEST_FAILED");
    expect(harness.controller.status().lastError).toBe(
      "GATEWAY_CODEX_REQUEST_FAILED",
    );
    expect(harness.store.snapshot().lastError).toBe(
      "GATEWAY_CODEX_REQUEST_FAILED",
    );
    expect(harness.sent.map(({ text }) => text).join("\n")).not.toContain(
      "secret filesystem path",
    );

    await harness.controller.accept([message("failed-turn", "run it")]);
    const call = harness.codex.startCalls.at(-1)!;
    harness.codex.emit({
      type: "turn-completed",
      threadId: call.threadId,
      turnId: call.turnId,
      status: "failed",
    });
    await tick();

    expect(harness.errors).toContain("GATEWAY_TURN_FAILED");
    expect(harness.controller.status().lastError).toBe("GATEWAY_TURN_FAILED");
    expect(harness.sent.map(({ text }) => text).join("\n")).toContain(
      "Codex 执行失败",
    );
  });

  it("does not dispatch or replay input after Codex disconnects", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([message("m1", "first")]);
    harness.codex.emit({ type: "disconnected" });

    await harness.controller.accept([message("m2", "second")]);
    expect(harness.codex.startCalls).toHaveLength(1);
    expect(harness.errors).toContain("GATEWAY_CODEX_DISCONNECTED");
    expect(harness.store.snapshot().handled).toContain("m2");
  });

  it("merges ordinary messages from one batch in arrival order", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.accept([
      message("one", "first"),
      message("two", "second"),
      message("three", "third"),
    ]);

    expect(harness.codex.startCalls).toHaveLength(1);
    expect(harness.codex.startCalls[0]?.text).toBe("first\n\nsecond\n\nthird");
  });

  it("keeps /newchat as a command boundary between ordinary groups", async () => {
    const harness = makeHarness();
    harness.codex.autoCompleteInterrupt = true;
    await harness.controller.initialize();

    await harness.controller.accept([
      message("one", "first"),
      message("new", " /newchat "),
      message("two", "second"),
    ]);

    expect(
      harness.codex.startCalls.map(({ threadId, text }) => ({
        threadId,
        text,
      })),
    ).toEqual([
      { threadId: "thread-1", text: "first" },
      { threadId: "thread-2", text: "second" },
    ]);
    expect(harness.codex.createdThreads).toEqual(["thread-1", "thread-2"]);
    expect(harness.codex.startCalls[1]?.text).not.toContain("first");
  });

  it("keeps a new-chat pointer empty across restart until the next message", async () => {
    const first = makeHarness();
    await first.controller.initialize();
    await first.controller.accept([message("m1", "first")]);
    await finishTurn(first.codex, first.codex.startCalls[0]!, "reply");
    await first.controller.accept([message("m2", "/newchat")]);
    expect(first.store.snapshot().threadId).toBeNull();
    await first.controller.close();

    const restarted = makeHarness(first.store.snapshot(), 2);
    await restarted.controller.initialize();
    await restarted.controller.accept([message("m3", "after new chat")]);

    expect(restarted.codex.resumedThreads).toEqual([]);
    expect(restarted.codex.createdThreads).toEqual(["thread-2"]);
    expect(restarted.codex.startCalls[0]).toMatchObject({
      threadId: "thread-2",
      text: "after new chat",
    });
  });

  it("warns once about recovered pending input before the next fresh message", async () => {
    const harness = makeHarness({
      schemaVersion: 1,
      threadId: "thread-recovered",
      handled: [],
      pending: ["uncertain"],
      lastError: null,
    });
    await harness.controller.initialize();

    await harness.controller.accept([message("fresh", "continue")]);
    await finishTurn(harness.codex, harness.codex.startCalls[0]!, "done");
    await harness.controller.accept([message("fresh-again", "continue again")]);
    await finishTurn(harness.codex, harness.codex.startCalls[1]!, "done again");

    const output = harness.sent.map(({ text }) => text).join("\n");
    expect(output.match(/上次连接中断时/g)).toHaveLength(1);
  });

  it("rejects accepts after close", async () => {
    const harness = makeHarness();
    await harness.controller.initialize();
    await harness.controller.close();

    await expect(
      harness.controller.accept([message("after-close", "ignored")]),
    ).rejects.toThrow("GATEWAY_CLOSED");
    expect(harness.codex.startCalls).toHaveLength(0);
  });
});
