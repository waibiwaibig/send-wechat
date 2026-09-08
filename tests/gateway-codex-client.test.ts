import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServer,
  type CodexModel,
  type CodexEvent,
  type GatewayPermission,
  type ModelSelection,
} from "../src/gateway/codex-client.js";

const fixture = fileURLToPath(
  new URL("./fixtures/gateway-fake-codex.mjs", import.meta.url),
);
const clients: CodexAppServer[] = [];

function makeClient(
  mode = "normal",
  requestTimeoutMs = 1_000,
  permission?: GatewayPermission,
): CodexAppServer {
  const client = new CodexAppServer({
    executable: process.execPath,
    cwd: process.cwd(),
    args: [fixture],
    env: {
      ...process.env,
      FAKE_CODEX_MODE: mode,
      ...(permission === undefined
        ? {}
        : { FAKE_CODEX_PERMISSION: permission }),
    },
    requestTimeoutMs,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("Codex app-server stdio gateway", () => {
  it("performs initialize/initialized and creates or resumes a thread", async () => {
    const client = makeClient();
    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.createThread()).resolves.toBe("thread-1");
    await expect(client.resumeThread("thread-1")).resolves.toEqual({
      model: "fake-model",
      effort: "medium",
    });
  });

  it("lists every model page and maps the protocol catalog", async () => {
    const client = makeClient("model-pages");
    await client.connect();

    await expect(client.listModels()).resolves.toEqual([
      {
        model: "fake-model",
        displayName: "Fake Model",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
      {
        model: "fake-model-2",
        displayName: "Fake Model Two",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "high",
        isDefault: false,
      },
    ] satisfies CodexModel[]);
  });

  it.each([
    ["normal", { model: "fake-model", effort: "medium" }],
    ["config-values", { model: "configured-model", effort: "high" }],
    ["config-model", { model: "fake-model-2", effort: null }],
    ["config-effort", { model: "fake-model", effort: "low" }],
  ] as const)(
    "resolves the default selection from config and the model catalog (%s)",
    async (mode, expected) => {
      const client = makeClient(mode);
      await client.connect();
      await expect(client.getDefaultSelection()).resolves.toEqual(expected);
    },
  );

  it("uses the required config/read request shape", async () => {
    const client = makeClient("config-payload");
    await client.connect();
    await expect(client.getDefaultSelection()).resolves.toEqual({
      model: "fake-model",
      effort: "medium",
    });
  });

  it.each([
    ["model-invalid-data", "invalid data"],
    ["model-invalid-cursor", "invalid nextCursor"],
    ["model-repeat", "repeated a pagination cursor"],
    ["model-many", "exceeded the pagination limit"],
    ["model-error", "model/list (400): model list failed"],
    ["config-invalid", "Expected string or null field model"],
    ["config-error", "config/read (400): config read failed"],
  ] as const)(
    "reports malformed model/config protocol data (%s)",
    async (mode, message) => {
      const client = makeClient(mode);
      await client.connect();
      const operation = mode.startsWith("config")
        ? client.getDefaultSelection()
        : client.listModels();
      await expect(operation).rejects.toThrow(message);
    },
  );

  it("forwards an explicit model and effort to thread/start", async () => {
    const client = makeClient("validate-selection");
    await client.connect();
    const selection: ModelSelection = {
      model: "selected-model",
      effort: "high",
    };
    await expect(client.createThread(selection)).resolves.toBe("thread-1");
  });

  it("omits the thread config override when effort is unset", async () => {
    const client = makeClient("validate-null-selection");
    await client.connect();
    await expect(
      client.createThread({ model: "selected-model", effort: null }),
    ).resolves.toBe("thread-1");
  });

  it("forwards an explicit model and effort to turn/start", async () => {
    const client = makeClient("validate-turn-selection");
    await client.connect();
    const selection: ModelSelection = {
      model: "selected-model",
      effort: "high",
    };
    await expect(
      client.startTurn("thread-1", "hello", selection),
    ).resolves.toBe("turn-1");
  });

  it.each(["full", "workspace", "read-only"] as const)(
    "maps the %s gateway permission to both protocol sandbox shapes",
    async (permission) => {
      const client = makeClient("validate-permission", 1_000, permission);
      await client.connect();
      const threadId = await client.createThread(undefined, permission);
      await expect(
        client.startTurn(threadId, "hello", undefined, permission),
      ).resolves.toBe("turn-1");
    },
  );

  it("injects the connection skill once for a newly created thread", async () => {
    const client = makeClient("validate-bootstrap");
    await client.connect();
    const threadId = await client.createThread();
    await expect(client.startTurn(threadId, "hello")).resolves.toBe("turn-1");
    await expect(client.startTurn(threadId, "hello")).resolves.toBe("turn-2");
  });

  it("does not inject the skill after resuming a thread", async () => {
    const client = makeClient("validate-bootstrap");
    await client.connect();
    const threadId = await client.createThread();
    await expect(client.resumeThread(threadId)).resolves.toEqual({
      model: "fake-model",
      effort: "medium",
    });
    await expect(client.startTurn(threadId, "hello")).resolves.toBe("turn-1");
  });

  it("consumes the bootstrap skill before a failed dispatch", async () => {
    const client = makeClient("bootstrap-error");
    await client.connect();
    const threadId = await client.createThread();
    await expect(client.startTurn(threadId, "hello")).rejects.toThrow(
      "bootstrap turn failed",
    );
    await expect(client.startTurn(threadId, "hello")).resolves.toBe("turn-1");
  });

  it("maps only agent message and turn notifications, preserving arrival order", async () => {
    const client = makeClient();
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();
    const turnId = await client.startTurn("thread-1", "hello");

    expect(turnId).toBe("turn-1");
    expect(events).toEqual([
      {
        type: "delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        text: "hello",
      },
      {
        type: "message-completed",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        text: "hello world",
      },
      {
        type: "turn-completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
      },
    ]);
  });

  it("uses the protocol turn id for interruption", async () => {
    const client = makeClient();
    await client.connect();
    await expect(
      client.interruptTurn("thread-1", "turn-1"),
    ).resolves.toBeUndefined();
  });

  it("declines an approval request promptly and exposes a notice", async () => {
    const client = makeClient("approval-request");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "run")).resolves.toBe("turn-1");
    expect(events).toEqual([
      {
        type: "notice",
        text: "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ]);
  });

  it("returns method-not-found for an unknown server request", async () => {
    const client = makeClient("unknown-request");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "hello")).resolves.toBe("turn-1");
    expect(events).toEqual([]);
  });

  it("fails closed on invalid JSON and rejects the in-flight request", async () => {
    const client = makeClient("bad-json");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "hello")).rejects.toThrow(
      "invalid JSON",
    );
    expect(events).toContainEqual({ type: "disconnected" });
  });

  it("fails closed on timeout and refuses later work on the dead process", async () => {
    const client = makeClient("timeout", 500);
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();
    await expect(client.createThread()).rejects.toThrow("timed out");
    expect(events).toContainEqual({ type: "disconnected" });
    await expect(client.createThread()).rejects.toThrow("disconnected");
  });

  it("rejects pending requests when the child exits", async () => {
    const client = makeClient("exit");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "hello")).rejects.toThrow(
      "disconnected",
    );
    expect(events).toContainEqual({ type: "disconnected" });
  });

  it("fails closed when the child exits before initialization", async () => {
    const client = makeClient("exit-initialize");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));

    await expect(client.connect()).rejects.toThrow("disconnected");
    expect(events).toEqual([{ type: "disconnected" }]);
  });

  it("fails closed when skill registration is rejected during connect", async () => {
    const client = makeClient("registration-error");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));

    await expect(client.connect()).rejects.toThrow(
      "skills/extraRoots/set (400): skill registration failed",
    );
    expect(events).toEqual([{ type: "disconnected" }]);
  });

  it("rejects a request when the connected child exits early", async () => {
    const client = makeClient("exit-thread");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.createThread()).rejects.toThrow("disconnected");
    expect(events).toEqual([{ type: "disconnected" }]);
  });

  it("rejects every pending request when a shared timeout closes the process", async () => {
    const client = makeClient("timeout-all", 100);
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    const results = await Promise.allSettled([
      client.createThread(),
      client.resumeThread("thread-1"),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("timed out"),
      }),
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("timed out"),
      }),
    });
    expect(
      events.filter((event) => event.type === "disconnected"),
    ).toHaveLength(1);
  });

  it("handles fragmented UTF-8 frames with CRLF delimiters", async () => {
    const client = makeClient("fragmented");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "你好")).resolves.toBe("turn-1");
    expect(events).toEqual([
      {
        type: "delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        text: "你好🌟",
      },
      {
        type: "message-completed",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        text: "你好🌟",
      },
      {
        type: "turn-completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
      },
    ]);
  });

  it.each(["oversized-buffer", "oversized-line"])(
    "fails closed when a %s frame exceeds the protocol limit",
    async (mode) => {
      const client = makeClient(mode);
      const events: CodexEvent[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      await expect(client.startTurn("thread-1", "hello")).rejects.toThrow(
        "frame exceeds the size limit",
      );
      expect(events).toEqual([{ type: "disconnected" }]);
    },
  );

  it("coalesces concurrent connect calls and makes close idempotent", async () => {
    const client = makeClient();
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));

    await expect(
      Promise.all([client.connect(), client.connect()]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(
      Promise.all([client.close(), client.close(), client.close()]),
    ).resolves.toEqual([undefined, undefined, undefined]);
    expect(events).toEqual([{ type: "disconnected" }]);
    await expect(client.connect()).rejects.toThrow("disconnected");
  });

  it("rejects all operations before a connection exists and closes cleanly", async () => {
    const client = makeClient();
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));

    await expect(client.createThread()).rejects.toThrow("disconnected");
    await expect(client.resumeThread("thread-1")).rejects.toThrow(
      "disconnected",
    );
    await expect(client.startTurn("thread-1", "hello")).rejects.toThrow(
      "disconnected",
    );
    await expect(client.interruptTurn("thread-1", "turn-1")).rejects.toThrow(
      "disconnected",
    );
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
    expect(events).toEqual([{ type: "disconnected" }]);
  });

  it.each([
    [
      "approval-request",
      "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
      "thread-1",
      "turn-1",
    ],
    [
      "approval-file",
      "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
      "thread-1",
      "turn-1",
    ],
    [
      "approval-permissions",
      "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
      "thread-1",
      "turn-1",
    ],
    [
      "approval-user-input",
      "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
      "thread-1",
      "turn-1",
    ],
    [
      "approval-elicitation",
      "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
      "thread-1",
      "turn-1",
    ],
    [
      "dynamic-tool",
      "Codex请求了gateway暂不支持的交互，本次请求已拒绝。",
      "thread-1",
      "turn-1",
    ],
  ] as const)(
    "returns a valid decline for %s",
    async (mode, notice, threadId, turnId) => {
      const client = makeClient(mode);
      const events: CodexEvent[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      await expect(client.startTurn("thread-1", "run")).resolves.toBe("turn-1");
      expect(events).toEqual([
        { type: "notice", text: notice, threadId, turnId },
      ]);
    },
  );

  it("does not invent context fields for a server request without params", async () => {
    const client = makeClient("approval-no-context");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "run")).resolves.toBe("turn-1");
    expect(events).toEqual([
      {
        type: "notice",
        text: "此请求需要在支持的 Codex 客户端中处理，本 gateway 已拒绝。",
      },
    ]);
  });

  it.each([
    ["known-refresh", "-32000"],
    ["known-attestation", "-32000"],
    ["unknown-request", "-32601"],
  ] as const)("returns the protocol error for %s", async (mode, code) => {
    const client = makeClient(mode);
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "run")).resolves.toBe("turn-1");
    expect(events).toEqual(
      mode === "unknown-request"
        ? []
        : [
            {
              type: "notice",
              text: "Codex请求了gateway暂不支持的交互，本次请求已拒绝。",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          ],
    );
    expect(code).toMatch(/^-\d+$/);
  });

  it("fails closed on malformed required notifications", async () => {
    for (const mode of ["invalid-delta", "invalid-turn-completed"]) {
      const client = makeClient(mode);
      const events: CodexEvent[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      await expect(client.startTurn("thread-1", "hello")).rejects.toThrow(
        "invalid params",
      );
      expect(events).toEqual([{ type: "disconnected" }]);
    }
  });

  it("ignores malformed completed-item notifications while completing the request", async () => {
    const client = makeClient("invalid-completed");
    const events: CodexEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();

    await expect(client.startTurn("thread-1", "hello")).resolves.toBe("turn-1");
    expect(events).toEqual([]);
  });

  it.each(["invalid-array", "invalid-message"])(
    "fails closed on an invalid JSON-RPC %s",
    async (mode) => {
      const client = makeClient(mode);
      const events: CodexEvent[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      await expect(client.startTurn("thread-1", "hello")).rejects.toThrow(
        "invalid JSON-RPC",
      );
      expect(events).toEqual([{ type: "disconnected" }]);
    },
  );

  it("preserves JSON-RPC error details and stays connected", async () => {
    const client = makeClient("response-error");
    await client.connect();

    await expect(client.createThread()).rejects.toThrow(
      "thread/start (400): thread failed",
    );
    await expect(
      client.interruptTurn("thread-1", "turn-1"),
    ).resolves.toBeUndefined();
  });

  it("reports missing response objects from the protocol methods", async () => {
    const missingThread = makeClient("missing-thread");
    await missingThread.connect();
    await expect(missingThread.createThread()).rejects.toThrow(
      "Expected object field thread",
    );

    const missingTurn = makeClient("missing-turn");
    await missingTurn.connect();
    await expect(missingTurn.startTurn("thread-1", "hello")).rejects.toThrow(
      "Expected object field turn",
    );
  });

  it("ignores an unmatched response and listener errors", async () => {
    const client = makeClient("unknown-response");
    client.onEvent(() => {
      throw new Error("consumer failure");
    });
    await client.connect();
    await expect(client.startTurn("thread-1", "hello")).resolves.toBe("turn-1");
  });

  it("rejects invalid request timeout configuration", () => {
    expect(
      () =>
        new CodexAppServer({
          executable: process.execPath,
          cwd: process.cwd(),
          requestTimeoutMs: 0,
        }),
    ).toThrow("requestTimeoutMs must be a positive finite number");
  });
});
