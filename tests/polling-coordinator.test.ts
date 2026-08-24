import { describe, expect, it } from "vitest";

import { PollingCoordinator } from "../src/runtime/polling-coordinator.js";
import type { PollUpdatesResult } from "../src/ilink/client.js";
import type { CredentialStore, StateStore } from "../src/runtime/ports.js";
import type { PersistedState, SecretBundle } from "../src/runtime/state.js";

class MemoryStateStore implements StateStore {
  public saves: PersistedState[] = [];
  public constructor(public state: PersistedState | null) {}
  async load(): Promise<PersistedState | null> {
    return structuredClone(this.state);
  }
  async save(state: PersistedState): Promise<void> {
    this.state = structuredClone(state);
    this.saves.push(structuredClone(state));
  }
  async delete(): Promise<void> {
    this.state = null;
  }
}

class MemoryCredentialStore implements CredentialStore {
  public saves: SecretBundle[] = [];
  public constructor(public secret: SecretBundle | null) {}
  async load(): Promise<SecretBundle | null> {
    return structuredClone(this.secret);
  }
  async save(secret: SecretBundle): Promise<void> {
    this.secret = structuredClone(secret);
    this.saves.push(structuredClone(secret));
  }
  async delete(): Promise<void> {
    this.secret = null;
  }
  async available(): Promise<boolean> {
    return true;
  }
}

const now = Date.parse("2026-08-24T12:00:00.000Z");

function state(lastInboundAt: number | null = null): PersistedState {
  return {
    schemaVersion: 1,
    binding: {
      botId: "bot-id",
      userId: "bound-user",
      baseUrl: "https://ilinkai.weixin.qq.com",
      boundAt: "2026-08-20T00:00:00.000Z",
    },
    pollCursor: "cursor",
    lastInboundAt,
    reminderAttemptedFor: lastInboundAt,
    authStale: false,
  };
}

const secret: SecretBundle = {
  schemaVersion: 1,
  botToken: "bot-token",
  contextToken: null,
};

describe("polling coordinator interface", () => {
  it("idles without a binding and backs off bounded retry failures", async () => {
    const idle = new PollingCoordinator({
      stateStore: new MemoryStateStore(null),
      credentialStore: new MemoryCredentialStore(null),
      ilink: {
        async pollUpdates() {
          throw new Error("must not poll");
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0,
    });
    await expect(idle.pollOnce()).resolves.toEqual({
      status: "idle",
      nextDelayMs: 1000,
    });

    const staleState = new MemoryStateStore({ ...state(), authStale: true });
    const stale = new PollingCoordinator({
      stateStore: staleState,
      credentialStore: new MemoryCredentialStore(secret),
      ilink: {
        async pollUpdates() {
          throw new Error("must not poll");
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0,
    });
    await expect(stale.pollOnce()).resolves.toEqual({
      status: "auth_stale",
      nextDelayMs: 5000,
    });

    let failures = 0;
    const retry = new PollingCoordinator({
      stateStore: new MemoryStateStore(state()),
      credentialStore: new MemoryCredentialStore(secret),
      ilink: {
        async pollUpdates() {
          failures += 1;
          return { status: "retry", code: "NETWORK_FAILURE" };
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0,
    });
    await expect(retry.pollOnce()).resolves.toEqual({
      status: "retry",
      nextDelayMs: 800,
    });
    await expect(retry.pollOnce()).resolves.toEqual({
      status: "retry",
      nextDelayMs: 1600,
    });
    expect(failures).toBe(2);
  });

  it("persists only the bound user's latest context metadata before advancing the cursor", async () => {
    const stateStore = new MemoryStateStore(state());
    const credentialStore = new MemoryCredentialStore(secret);
    const confirmations: unknown[] = [];
    const result: PollUpdatesResult = {
      status: "ok",
      cursor: "next-cursor",
      suggestedTimeoutMs: 27000,
      inbound: [
        {
          messageType: 1,
          fromUserId: "other-user",
          contextToken: "wrong-context",
          createTimeMs: now - 2000,
        },
        {
          messageType: 1,
          fromUserId: "bound-user",
          contextToken: "new-context",
          createTimeMs: now - 1000,
        },
      ],
    };
    const coordinator = new PollingCoordinator({
      stateStore,
      credentialStore,
      ilink: {
        async pollUpdates() {
          return result;
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute(command) {
          confirmations.push({
            command,
            recordedLastInboundAt: stateStore.state?.lastInboundAt,
            recordedContextToken: credentialStore.secret?.contextToken,
          });
          return { ok: true };
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });

    await expect(coordinator.pollOnce()).resolves.toEqual({
      status: "ok",
      nextDelayMs: 0,
    });
    expect(credentialStore.secret).toEqual({
      schemaVersion: 1,
      botToken: "bot-token",
      contextToken: "new-context",
    });
    expect(stateStore.state).toMatchObject({
      pollCursor: "next-cursor",
      lastInboundAt: now - 1000,
      reminderAttemptedFor: null,
    });
    expect(credentialStore.saves).toHaveLength(1);
    expect(stateStore.saves).toHaveLength(1);

    await coordinator.pollOnce();

    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      command: {
        type: "send-text",
        requestId: `connection:${now - 1000}`,
        idempotencyKey: `connection:${now - 1000}`,
        text: "send-wechat 已连接，可以开始使用。 / send-wechat is connected and ready.",
        purpose: "connection",
      },
      recordedLastInboundAt: now - 1000,
      recordedContextToken: "new-context",
    });
  });

  it("renews an existing session without sending another connection confirmation", async () => {
    const stateStore = new MemoryStateStore(state(now - 60_000));
    const credentialStore = new MemoryCredentialStore({
      ...secret,
      contextToken: "old-context",
    });
    const deliveries: unknown[] = [];
    const coordinator = new PollingCoordinator({
      stateStore,
      credentialStore,
      ilink: {
        async pollUpdates() {
          return {
            status: "ok",
            cursor: "next-cursor",
            suggestedTimeoutMs: 27000,
            inbound: [
              {
                messageType: 1,
                fromUserId: "bound-user",
                contextToken: "renewed-context",
                createTimeMs: now - 1000,
              },
            ],
          };
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute(command) {
          deliveries.push(command);
          return { ok: true };
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });

    await expect(coordinator.pollOnce()).resolves.toEqual({
      status: "ok",
      nextDelayMs: 0,
    });
    expect(stateStore.state?.lastInboundAt).toBe(now - 1000);
    expect(credentialStore.secret?.contextToken).toBe("renewed-context");
    expect(deliveries).toEqual([]);
  });

  it("marks stale authentication and stops treating the session as ready", async () => {
    const stateStore = new MemoryStateStore(state(now - 60_000));
    const coordinator = new PollingCoordinator({
      stateStore,
      credentialStore: new MemoryCredentialStore({
        ...secret,
        contextToken: "context",
      }),
      ilink: {
        async pollUpdates() {
          return { status: "auth_stale" };
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          throw new Error("not due");
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });

    await expect(coordinator.pollOnce()).resolves.toEqual({
      status: "auth_stale",
      nextDelayMs: 5000,
    });
    expect(stateStore.state?.authStale).toBe(true);
  });

  it("records the hour-22 reminder before enqueueing it and never repeats it", async () => {
    const windowStart = now - 22 * 60 * 60 * 1000;
    const due = state(windowStart);
    due.reminderAttemptedFor = null;
    const stateStore = new MemoryStateStore(due);
    const reminders: unknown[] = [];
    const coordinator = new PollingCoordinator({
      stateStore,
      credentialStore: new MemoryCredentialStore({
        ...secret,
        contextToken: "context",
      }),
      ilink: {
        async pollUpdates() {
          return {
            status: "ok",
            cursor: "next",
            suggestedTimeoutMs: 35000,
            inbound: [],
          };
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute(command) {
          reminders.push({
            command,
            recorded: stateStore.state?.reminderAttemptedFor,
          });
          return { ok: true };
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });

    await coordinator.pollOnce();
    await coordinator.pollOnce();

    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      command: {
        type: "send-text",
        idempotencyKey: `reminder:${windowStart}`,
        purpose: "reminder",
      },
      recorded: windowStart,
    });
  });

  it("uses a bounded timestamp for implausible inbound messages and still confirms connection", async () => {
    const stateStore = new MemoryStateStore(state());
    const credentialStore = new MemoryCredentialStore(secret);
    const deliveries: unknown[] = [];
    const coordinator = new PollingCoordinator({
      stateStore,
      credentialStore,
      ilink: {
        async pollUpdates() {
          return {
            status: "ok",
            cursor: "next",
            suggestedTimeoutMs: 35000,
            inbound: [
              {
                messageType: 1,
                fromUserId: "bound-user",
                contextToken: "new",
                createTimeMs: now + 60 * 60 * 1000,
              },
            ],
          };
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => false,
        async execute(command) {
          deliveries.push(command);
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });
    await expect(coordinator.pollOnce()).resolves.toEqual({
      status: "ok",
      nextDelayMs: 0,
    });
    expect(stateStore.state?.lastInboundAt).toBe(now);
    expect(deliveries).toMatchObject([
      {
        purpose: "connection",
        idempotencyKey: `connection:${now}`,
      },
    ]);
  });

  it("announces lifecycle when login appears after the daemon was already started", async () => {
    const stateStore = new MemoryStateStore(null);
    const credentialStore = new MemoryCredentialStore(null);
    const lifecycle: string[] = [];
    const abort = new AbortController();
    let sleeps = 0;
    const coordinator = new PollingCoordinator({
      stateStore,
      credentialStore,
      ilink: {
        async pollUpdates() {
          abort.abort();
          return { status: "retry", code: "done" };
        },
        async notifyLifecycle(params) {
          lifecycle.push(params.type);
        },
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return { ok: true };
        },
      },
      clock: { now: () => now },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          stateStore.state = state();
          credentialStore.secret = structuredClone(secret);
        }
      },
      random: () => 0.5,
    });

    await coordinator.run(abort.signal);

    expect(lifecycle).toEqual(["start", "stop"]);
  });

  it("fully aborts an old long poll before entering the login critical section", async () => {
    const events: string[] = [];
    let markPollStarted: (() => void) | undefined;
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    const overallAbort = new AbortController();
    const coordinator = new PollingCoordinator({
      stateStore: new MemoryStateStore(state()),
      credentialStore: new MemoryCredentialStore(secret),
      ilink: {
        async pollUpdates(params) {
          events.push("poll-started");
          markPollStarted?.();
          await new Promise<void>((resolve) => {
            if (params.signal?.aborted) resolve();
            else
              params.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          events.push("poll-stopped");
          return { status: "retry", code: "ABORTED" };
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return { ok: true };
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });
    const running = coordinator.run(overallAbort.signal);
    await pollStarted;

    await coordinator.withPollingPaused(async () => {
      events.push("login");
    });
    overallAbort.abort();
    await running;

    expect(events.slice(0, 3)).toEqual([
      "poll-started",
      "poll-stopped",
      "login",
    ]);
  });

  it("backs off unexpected poll errors and waits while a pause is held", async () => {
    const abort = new AbortController();
    let polls = 0;
    let sleeps = 0;
    const coordinator = new PollingCoordinator({
      stateStore: new MemoryStateStore(state()),
      credentialStore: new MemoryCredentialStore({
        ...secret,
        contextToken: "context",
      }),
      ilink: {
        async pollUpdates() {
          polls += 1;
          throw new Error("unexpected poll error");
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {
        sleeps += 1;
        abort.abort();
      },
      random: () => 0,
    });
    await coordinator.run(abort.signal);
    expect(polls).toBe(1);
    expect(sleeps).toBe(1);

    const pauseAbort = new AbortController();
    let pollStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      pollStarted = resolve;
    });
    let releasePause: (() => void) | undefined;
    const coordinatorWithPause = new PollingCoordinator({
      stateStore: new MemoryStateStore(state()),
      credentialStore: new MemoryCredentialStore({
        ...secret,
        contextToken: "context",
      }),
      ilink: {
        async pollUpdates(params) {
          pollStarted?.();
          await new Promise<void>((resolve) =>
            params.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          throw new Error("aborted");
        },
        async notifyLifecycle() {},
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });
    const running = coordinatorWithPause.run(pauseAbort.signal);
    await started;
    const paused = coordinatorWithPause.withPollingPaused(
      async () =>
        await new Promise<void>((resolve) => {
          releasePause = resolve;
        }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    releasePause?.();
    await paused;
    pauseAbort.abort();
    await running;
  });

  it("continues after a rejected pause operation and tolerates lifecycle notification failures", async () => {
    const coordinator = new PollingCoordinator({
      stateStore: new MemoryStateStore(state()),
      credentialStore: new MemoryCredentialStore({
        ...secret,
        contextToken: "context",
      }),
      ilink: {
        async pollUpdates() {
          return { status: "retry", code: "retry" };
        },
        async notifyLifecycle() {
          throw new Error("notify unavailable");
        },
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });
    await expect(
      coordinator.withPollingPaused(async () => {
        throw new Error("login failed");
      }),
    ).rejects.toThrow("login failed");
    await expect(coordinator.withPollingPaused(async () => "ok")).resolves.toBe(
      "ok",
    );

    const abort = new AbortController();
    let calls = 0;
    const running = new PollingCoordinator({
      stateStore: new MemoryStateStore(state()),
      credentialStore: new MemoryCredentialStore({
        ...secret,
        contextToken: "context",
      }),
      ilink: {
        async pollUpdates() {
          calls += 1;
          abort.abort();
          return { status: "retry", code: "stop" };
        },
        async notifyLifecycle() {
          throw new Error("notify unavailable");
        },
      },
      runtime: {
        isDeliveryIdle: () => true,
        async execute() {
          return {};
        },
      },
      clock: { now: () => now },
      sleep: async () => {},
      random: () => 0.5,
    });
    await running.run(abort.signal);
    expect(calls).toBe(1);
  });
});
