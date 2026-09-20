import { describe, expect, it, vi } from "vitest";

import {
  ChannelRouter,
  type ChannelRuntime,
} from "../src/messaging/channel-router.js";
import type {
  RuntimeCommand,
  RuntimeResponse,
} from "../src/runtime/application.js";

const status = (requestId: string, state = "ready"): RuntimeResponse => ({
  ok: true,
  command: "status",
  requestId,
  result: {
    state: state as "ready",
    boundAt: null,
    lastInboundAt: null,
    renewalDueAt: null,
    expiresAt: null,
  },
});

const accepted = (
  requestId: string,
  idempotencyKey: string,
): RuntimeResponse => ({
  ok: true,
  command: "send",
  requestId,
  result: {
    state: "accepted",
    idempotencyKey,
    clientMessageId: `${requestId}-message`,
    deduplicated: false,
  },
});

const sendCommand = (
  channel?: "wechat" | "feishu" | "both",
): RuntimeCommand & {
  channel?: "wechat" | "feishu" | "both";
} => ({
  type: "send-text",
  requestId: "request-1",
  idempotencyKey: "same-key",
  text: "hello",
  ...(channel === undefined ? {} : { channel }),
});

function provider(
  response: RuntimeResponse | Error,
): ChannelRuntime & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { execute };
}

describe("channel router", () => {
  it("uses the configured default channel and strips routing metadata", async () => {
    const wechat = provider(accepted("request-1", "same-key"));
    const feishu = provider(accepted("request-1", "same-key"));
    const router = new ChannelRouter({
      defaultChannel: "wechat",
      providers: { wechat, feishu },
    });

    const result = await router.execute(sendCommand());

    expect(result).toMatchObject({ ok: true, result: { state: "accepted" } });
    expect(wechat.execute).toHaveBeenCalledWith({
      type: "send-text",
      requestId: "request-1",
      idempotencyKey: "same-key",
      text: "hello",
    });
    expect(feishu.execute).not.toHaveBeenCalled();
  });

  it("routes an explicit channel without falling back", async () => {
    const wechat = provider(accepted("request-1", "same-key"));
    const router = new ChannelRouter({
      defaultChannel: "wechat",
      providers: { wechat },
    });

    const result = await router.execute(sendCommand("feishu"));

    expect(result).toMatchObject({
      ok: false,
      command: "send",
      requestId: "request-1",
      result: {
        state: "failed",
        channels: {
          feishu: { ok: false, error: { code: "CHANNEL_NOT_CONFIGURED" } },
        },
      },
      error: { code: "CHANNEL_SEND_FAILED", retryable: false },
    });
    expect(wechat.execute).not.toHaveBeenCalled();
  });

  it("runs both channels concurrently with the same idempotency key", async () => {
    const calls: string[] = [];
    const wechat: ChannelRuntime = {
      execute: async (command) => {
        calls.push(`wechat-start-${command.requestId}`);
        await Promise.resolve();
        calls.push("wechat-end");
        if (command.type === "status") throw new Error("unexpected status");
        return accepted(command.requestId, command.idempotencyKey);
      },
    };
    const feishu: ChannelRuntime = {
      execute: async (command) => {
        calls.push(`feishu-start-${command.requestId}`);
        await Promise.resolve();
        calls.push("feishu-end");
        if (command.type === "status") throw new Error("unexpected status");
        return accepted(command.requestId, command.idempotencyKey);
      },
    };
    const router = new ChannelRouter({
      defaultChannel: "wechat",
      providers: { wechat, feishu },
    });

    const result = await router.execute(sendCommand("both"));

    expect(result).toMatchObject({
      ok: true,
      result: {
        state: "accepted",
        channels: { wechat: { ok: true }, feishu: { ok: true } },
      },
    });
    expect(calls.slice(0, 2)).toEqual([
      "wechat-start-request-1",
      "feishu-start-request-1",
    ]);
  });

  it("reports partial success and preserves the independent provider result", async () => {
    const wechat = provider(accepted("request-1", "same-key"));
    const feishu = provider({
      ok: false,
      command: "send",
      requestId: "request-1",
      idempotencyKey: "same-key",
      error: {
        code: "SERVER_REJECTED",
        message: "rejected",
        retryable: false,
      },
    });
    const router = new ChannelRouter({
      defaultChannel: "wechat",
      providers: { wechat, feishu },
    });

    const result = await router.execute(sendCommand("both"));

    expect(result).toMatchObject({
      ok: false,
      result: {
        state: "partial",
        channels: {
          wechat: { ok: true },
          feishu: { ok: false, error: { code: "SERVER_REJECTED" } },
        },
      },
      error: { code: "CHANNEL_SEND_FAILED", retryable: false },
    });
  });

  it("turns provider throws into unknown results without affecting the other channel", async () => {
    const wechat = provider(accepted("request-1", "same-key"));
    const feishu = provider(new Error("network stopped"));
    const router = new ChannelRouter({
      defaultChannel: "wechat",
      providers: { wechat, feishu },
    });

    const result = await router.execute(sendCommand("both"));

    expect(result).toMatchObject({
      ok: false,
      result: {
        state: "partial",
        channels: {
          wechat: { ok: true },
          feishu: {
            ok: false,
            error: { code: "RESULT_UNKNOWN", retryable: false },
          },
        },
      },
    });
  });

  it("queries every configured provider for status and retains errors", async () => {
    const wechat = provider(status("request-1"));
    const feishu = provider(new Error("status unavailable"));
    const router = new ChannelRouter({
      defaultChannel: "wechat",
      providers: { wechat, feishu },
    });

    const result = await router.execute({
      type: "status",
      requestId: "request-1",
    });

    expect(result).toMatchObject({
      ok: false,
      command: "status",
      result: {
        defaultChannel: "wechat",
        channels: {
          wechat: { state: "ready" },
          feishu: { ok: false, error: { code: "RESULT_UNKNOWN" } },
        },
      },
      error: { code: "CHANNEL_SEND_FAILED", retryable: false },
    });
    expect(wechat.execute).toHaveBeenCalledWith({
      type: "status",
      requestId: "request-1",
    });
    expect(feishu.execute).toHaveBeenCalledWith({
      type: "status",
      requestId: "request-1",
    });
  });
});
