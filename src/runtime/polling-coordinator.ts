import { createHash } from "node:crypto";

import type { PollUpdatesResult } from "../ilink/client.js";
import type { InboundText } from "../messaging/text-inbox.js";
import type { SendTextCommand } from "./application.js";
import type { Clock, CredentialStore, StateStore } from "./ports.js";
import {
  isRecoverCommand,
  SESSION_BLOCK_AFTER_MS,
  SESSION_RENEWAL_AFTER_MS,
} from "./session-policy.js";

const AUTH_STALE_DELAY_MS = 5000;
const IDLE_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const MIN_PLAUSIBLE_MESSAGE_TIME = Date.parse("2020-01-01T00:00:00.000Z");
const CONNECTION_CONFIRMATION_TEXT =
  "send-wechat 已连接，可以开始使用。 / send-wechat is connected and ready.";
const RECOVERY_CONFIRMATION_TEXT =
  "send-wechat 会话已续期，可以继续使用。 / Session renewed; you can continue using send-wechat.";

export type PollingIlinkPort = {
  pollUpdates(params: {
    baseUrl: string;
    botToken: string;
    cursor: string;
    signal?: AbortSignal;
  }): Promise<PollUpdatesResult>;
  notifyLifecycle(params: {
    type: "start" | "stop";
    baseUrl: string;
    botToken: string;
  }): Promise<void>;
};

export type ReminderRuntime = {
  isDeliveryIdle(): boolean;
  execute(command: SendTextCommand): Promise<unknown>;
};

export type PollingTextInboxPort = {
  append(messages: InboundText[]): void;
};

export type PollingCoordinatorDependencies = {
  stateStore: StateStore;
  credentialStore: CredentialStore;
  ilink: PollingIlinkPort;
  runtime: ReminderRuntime;
  clock: Clock;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
  inbox?: PollingTextInboxPort;
};

export type PollOnceResult = {
  status: "ok" | "idle" | "retry" | "auth_stale";
  nextDelayMs: number;
};

export class PollingCoordinator {
  private consecutiveFailures = 0;
  private paused = false;
  private activePoll: Promise<PollOnceResult> | null = null;
  private activePollAbort: AbortController | null = null;
  private pauseTail: Promise<void> = Promise.resolve();
  private readonly resumeWaiters = new Set<() => void>();

  public constructor(
    private readonly dependencies: PollingCoordinatorDependencies,
  ) {}

  public withPollingPaused<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pauseTail.then(async () => {
      this.paused = true;
      this.activePollAbort?.abort();
      await this.activePoll?.catch(() => undefined);
      try {
        return await operation();
      } finally {
        this.paused = false;
        for (const resume of this.resumeWaiters) resume();
        this.resumeWaiters.clear();
      }
    });
    this.pauseTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public async pollOnce(signal?: AbortSignal): Promise<PollOnceResult> {
    const [state, secret] = await Promise.all([
      this.dependencies.stateStore.load(),
      this.dependencies.credentialStore.load(),
    ]);
    if (state === null || secret === null)
      return { status: "idle", nextDelayMs: IDLE_DELAY_MS };
    if (state.authStale)
      return { status: "auth_stale", nextDelayMs: AUTH_STALE_DELAY_MS };

    const result = await this.dependencies.ilink.pollUpdates({
      baseUrl: state.binding.baseUrl,
      botToken: secret.botToken,
      cursor: state.pollCursor,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.status === "auth_stale") {
      state.authStale = true;
      await this.dependencies.stateStore.save(state);
      this.consecutiveFailures = 0;
      return { status: "auth_stale", nextDelayMs: AUTH_STALE_DELAY_MS };
    }
    if (result.status === "retry") {
      this.consecutiveFailures += 1;
      return { status: "retry", nextDelayMs: this.backoffDelay() };
    }

    this.consecutiveFailures = 0;
    const validBoundMessages = result.inbound.filter(
      (message) =>
        message.messageType === 1 &&
        message.fromUserId === state.binding.userId,
    );
    const inboundCandidates = validBoundMessages
      .map((message) => ({
        message,
        effectiveTime: this.effectiveInboundTime(message.createTimeMs),
      }))
      .filter(
        ({ message, effectiveTime }) =>
          message.contextToken !== null &&
          message.contextToken !== "" &&
          (state.lastInboundAt === null || effectiveTime > state.lastInboundAt),
      )
      .sort((left, right) => left.effectiveTime - right.effectiveTime)
      .at(-1);

    const recovery = validBoundMessages
      .map((message) => ({
        message,
        effectiveTime: this.effectiveInboundTime(message.createTimeMs),
      }))
      .filter(({ message, effectiveTime }) =>
        this.isFreshRecoveryMessage(
          message,
          effectiveTime,
          state.lastInboundAt,
        ),
      )
      .sort((left, right) => left.effectiveTime - right.effectiveTime)
      .at(-1);

    const inboxMessages = validBoundMessages.flatMap((message) => {
      if (
        typeof message.id !== "string" ||
        typeof message.text !== "string" ||
        isRecoverCommand(message.text) ||
        !isValidInboundText(message.id, message.text)
      ) {
        return [];
      }
      return [
        {
          id: message.id,
          text: message.text,
          receivedAt: this.effectiveInboundTime(message.createTimeMs),
        },
      ];
    });
    const activatesConnection =
      inboundCandidates !== undefined &&
      recovery === undefined &&
      (state.lastInboundAt === null || secret.contextToken === null);
    if (inboundCandidates !== undefined) {
      const contextToken = inboundCandidates.message.contextToken;
      if (contextToken === null || contextToken === "")
        throw new Error("INBOUND_CONTEXT_TOKEN_INVALID");
      secret.contextToken = contextToken;
      await this.dependencies.credentialStore.save(secret);
      state.lastInboundAt = inboundCandidates.effectiveTime;
      state.reminderAttemptedFor = null;
    }
    state.pollCursor = result.cursor;
    await this.dependencies.stateStore.save(state);
    // Persist the cursor and renewed session before exposing ordinary input to
    // the secretary. Recovery is consumed above and never enters this inbox.
    if (this.dependencies.inbox !== undefined && inboxMessages.length > 0) {
      try {
        this.dependencies.inbox.append(inboxMessages);
      } catch {
        // A broken or busy optional inbox cannot stop cursor advancement,
        // session renewal, or the existing outbound delivery path.
      }
    }

    if (recovery !== undefined) {
      const idempotencyKey = recoveryIdempotencyKey(
        recovery.message.id,
        recovery.effectiveTime,
      );
      await this.dependencies.runtime
        .execute({
          type: "send-text",
          requestId: idempotencyKey,
          idempotencyKey,
          text: RECOVERY_CONFIRMATION_TEXT,
          purpose: "recovery",
        })
        .catch(() => undefined);
    } else if (activatesConnection && inboundCandidates !== undefined) {
      const idempotencyKey = `connection:${inboundCandidates.effectiveTime}`;
      await this.dependencies.runtime
        .execute({
          type: "send-text",
          requestId: idempotencyKey,
          idempotencyKey,
          text: CONNECTION_CONFIRMATION_TEXT,
          purpose: "connection",
        })
        .catch(() => undefined);
    }
    await this.maybeRemind(state.lastInboundAt, state.reminderAttemptedFor);
    return { status: "ok", nextDelayMs: 0 };
  }

  public async run(signal: AbortSignal): Promise<void> {
    let lifecycle: { baseUrl: string; botToken: string } | null = null;
    try {
      while (!signal.aborted) {
        await this.waitWhilePaused(signal);
        if (signal.aborted) break;
        lifecycle = await this.refreshLifecycle(lifecycle).catch(
          () => lifecycle,
        );
        if (this.paused) continue;
        const pollAbort = new AbortController();
        const pollSignal = AbortSignal.any([signal, pollAbort.signal]);
        const activePoll = this.pollOnce(pollSignal).catch(() => ({
          status: "retry" as const,
          nextDelayMs: this.backoffDelayAfterUnexpectedFailure(),
        }));
        this.activePollAbort = pollAbort;
        this.activePoll = activePoll;
        const result = await activePoll;
        if (this.activePoll === activePoll) {
          this.activePoll = null;
          this.activePollAbort = null;
        }
        if (signal.aborted) break;
        if (result.nextDelayMs > 0) {
          await this.waitForDelay(result.nextDelayMs, signal);
        }
      }
    } finally {
      if (lifecycle !== null) {
        await this.dependencies.ilink
          .notifyLifecycle({ type: "stop", ...lifecycle })
          .catch(() => undefined);
      }
    }
  }

  private async maybeRemind(
    lastInboundAt: number | null,
    reminderAttemptedFor: number | null,
  ): Promise<void> {
    if (lastInboundAt === null || reminderAttemptedFor === lastInboundAt)
      return;
    const age = this.dependencies.clock.now() - lastInboundAt;
    if (
      age < SESSION_RENEWAL_AFTER_MS ||
      age >= SESSION_BLOCK_AFTER_MS ||
      !this.dependencies.runtime.isDeliveryIdle()
    ) {
      return;
    }

    const state = await this.dependencies.stateStore.load();
    if (
      state === null ||
      state.lastInboundAt !== lastInboundAt ||
      state.reminderAttemptedFor === lastInboundAt
    ) {
      return;
    }
    state.reminderAttemptedFor = lastInboundAt;
    await this.dependencies.stateStore.save(state);
    await this.dependencies.runtime.execute({
      type: "send-text",
      requestId: `reminder:${lastInboundAt}`,
      idempotencyKey: `reminder:${lastInboundAt}`,
      text: "send-wechat 会话将在 1 小时内过期。请发送 /recover 续期。 / The session expires within 1 hour; send /recover to renew.",
      purpose: "reminder",
    });
  }

  private effectiveInboundTime(value: number | null): number {
    const now = this.dependencies.clock.now();
    if (
      value === null ||
      value < MIN_PLAUSIBLE_MESSAGE_TIME ||
      value > now + 5 * 60 * 1000
    ) {
      return now;
    }
    return value;
  }

  private isFreshRecoveryMessage(
    message: Extract<PollUpdatesResult, { status: "ok" }>["inbound"][number],
    effectiveTime: number,
    previousInboundAt: number | null,
  ): boolean {
    if (
      !isRecoverCommand(message.text ?? "") ||
      message.contextToken === null ||
      message.contextToken === ""
    )
      return false;
    const now = this.dependencies.clock.now();
    if (
      message.createTimeMs !== null &&
      (message.createTimeMs < MIN_PLAUSIBLE_MESSAGE_TIME ||
        message.createTimeMs > now + 5 * 60 * 1000)
    )
      return false;
    return (
      effectiveTime <= now &&
      now - effectiveTime < SESSION_BLOCK_AFTER_MS &&
      (previousInboundAt === null || effectiveTime > previousInboundAt)
    );
  }

  private backoffDelay(): number {
    const base = Math.min(
      MAX_BACKOFF_MS,
      1000 * 2 ** Math.min(this.consecutiveFailures - 1, 6),
    );
    const jitter = 0.8 + this.dependencies.random() * 0.4;
    return Math.round(base * jitter);
  }

  private backoffDelayAfterUnexpectedFailure(): number {
    this.consecutiveFailures += 1;
    return this.backoffDelay();
  }

  private async waitForDelay(
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.dependencies.sleep(milliseconds), aborted]);
    } finally {
      if (onAbort !== null) signal.removeEventListener("abort", onAbort);
    }
  }

  private async waitWhilePaused(signal: AbortSignal): Promise<void> {
    if (!this.paused || signal.aborted) return;
    let resume: (() => void) | null = null;
    let onAbort: (() => void) | null = null;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
      this.resumeWaiters.add(resolve);
    });
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([resumed, aborted]);
    } finally {
      if (resume !== null) this.resumeWaiters.delete(resume);
      if (onAbort !== null) signal.removeEventListener("abort", onAbort);
    }
  }

  private async refreshLifecycle(
    current: { baseUrl: string; botToken: string } | null,
  ): Promise<{ baseUrl: string; botToken: string } | null> {
    const [state, secret] = await Promise.all([
      this.dependencies.stateStore.load(),
      this.dependencies.credentialStore.load(),
    ]);
    const next =
      state === null || secret === null || state.authStale
        ? null
        : { baseUrl: state.binding.baseUrl, botToken: secret.botToken };
    if (
      current !== null &&
      (next === null ||
        current.baseUrl !== next.baseUrl ||
        current.botToken !== next.botToken)
    ) {
      await this.dependencies.ilink
        .notifyLifecycle({ type: "stop", ...current })
        .catch(() => undefined);
    }
    if (
      next !== null &&
      (current === null ||
        current.baseUrl !== next.baseUrl ||
        current.botToken !== next.botToken)
    ) {
      await this.dependencies.ilink
        .notifyLifecycle({ type: "start", ...next })
        .catch(() => undefined);
    }
    return next;
  }
}

function isValidInboundText(id: string, text: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(id) &&
    Array.from(text).length > 0 &&
    Array.from(text).length <= 4000 &&
    !/\u0000/.test(text)
  );
}

function recoveryIdempotencyKey(
  id: string | undefined,
  effectiveTime: number,
): string {
  if (id !== undefined && /^[A-Za-z0-9._:-]{1,118}$/.test(id))
    return `recover:${id}`;
  if (id !== undefined) {
    const digest = createHash("sha256").update(id).digest("hex");
    return `recover:${digest}`;
  }
  return `recover:at-${effectiveTime}`;
}
