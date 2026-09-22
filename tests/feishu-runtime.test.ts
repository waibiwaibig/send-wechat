import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FeishuRuntime } from "../src/feishu/runtime.js";
import { SqliteIdempotencyStore } from "../src/storage/idempotency-store.js";
import type { FeishuClient } from "../src/feishu/client.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function runtime(send: FeishuClient["send"]) {
  const dir = await mkdtemp(join(tmpdir(), "send-message-feishu-"));
  directories.push(dir);
  return new FeishuRuntime(
    { send },
    new SqliteIdempotencyStore(join(dir, "ledger.sqlite")),
  );
}
const command = {
  type: "send-text" as const,
  requestId: "r",
  idempotencyKey: "same",
  text: "hello",
};
it("reports observed listener health and the actual send outcome without probing or resending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feishu-health-"));
  directories.push(dir);
  const send = vi.fn<FeishuClient["send"]>().mockResolvedValue({
    status: "unknown",
    code: "SEND_CLI_TIMEOUT",
  });
  const observation = {
    listener: "failed" as const,
    lastListenerError: "CLI_INVALID_ARGUMENT",
    lastInboundAt: "2026-09-22T00:00:00.000Z",
    lastEnqueuedAt: null,
    lastInboundError: "INBOX_WRITE_FAILED",
  };
  const app = new FeishuRuntime(
    { send },
    new SqliteIdempotencyStore(join(dir, "ledger.sqlite")),
    () => observation,
  );
  await expect(
    app.execute({ type: "status", requestId: "status" }),
  ).resolves.toMatchObject({
    result: {
      lastInboundAt: observation.lastInboundAt,
      diagnostics: { readiness: "configured", ...observation, lastSend: null },
    },
  });
  expect(send).not.toHaveBeenCalled();
  await app.execute(command);
  await expect(
    app.execute({ type: "status", requestId: "status" }),
  ).resolves.toMatchObject({
    result: {
      diagnostics: {
        lastSend: {
          status: "unknown",
          code: "SEND_CLI_TIMEOUT",
          at: expect.any(String),
        },
      },
    },
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("deduplicates accepted sends and rejects changed payloads", async () => {
  const send = vi
    .fn<FeishuClient["send"]>()
    .mockResolvedValue({ status: "accepted", clientMessageId: "m" });
  const app = await runtime(send);
  expect((await app.execute(command)).ok).toBe(true);
  expect(await app.execute(command)).toMatchObject({
    result: { deduplicated: true },
  });
  expect(await app.execute({ ...command, text: "changed" })).toMatchObject({
    error: { code: "IDEMPOTENCY_CONFLICT" },
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("never repeats unknown outcomes or thrown sends", async () => {
  const send = vi
    .fn<FeishuClient["send"]>()
    .mockRejectedValue(new Error("timeout"));
  const app = await runtime(send);
  expect(await app.execute(command)).toMatchObject({
    error: { code: "RESULT_UNKNOWN" },
  });
  expect(await app.execute(command)).toMatchObject({
    error: { code: "RESULT_UNKNOWN" },
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("serializes concurrent requests with the same key", async () => {
  const send = vi
    .fn<FeishuClient["send"]>()
    .mockResolvedValue({ status: "accepted", clientMessageId: "m" });
  const app = await runtime(send);
  const results = await Promise.all([
    app.execute(command),
    app.execute(command),
  ]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["failed", "rejected"] as const)(
  "keeps %s outcomes terminal",
  async (status) => {
    const send = vi
      .fn<FeishuClient["send"]>()
      .mockResolvedValue({ status, code: "UPSTREAM" });
    const app = await runtime(send);
    await app.execute(command);
    await app.execute(command);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["rejected", "FEISHU_230101", "SERVER_REJECTED"],
  ["failed", "UPLOAD_CLI_TIMEOUT", "PRE_SEND_FAILED"],
  ["unknown", "SEND_CLI_TIMEOUT", "RESULT_UNKNOWN"],
] as const)(
  "preserves the %s provider code on first and duplicate responses",
  async (status, providerCode, semanticCode) => {
    const send = vi
      .fn<FeishuClient["send"]>()
      .mockResolvedValue({ status, code: providerCode });
    const app = await runtime(send);

    expect(await app.execute(command)).toMatchObject({
      error: {
        code: semanticCode,
        causeCode: providerCode,
        retryable: false,
      },
    });
    expect(await app.execute(command)).toMatchObject({
      error: {
        code: semanticCode,
        causeCode: providerCode,
        retryable: false,
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it("decodes a typed result after reopening the persisted ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "send-message-feishu-"));
  directories.push(dir);
  const ledgerPath = join(dir, "ledger.sqlite");
  const send = vi
    .fn<FeishuClient["send"]>()
    .mockResolvedValue({ status: "rejected", code: "FEISHU_230101" });
  const firstRuntime = new FeishuRuntime(
    { send },
    new SqliteIdempotencyStore(ledgerPath),
  );
  await firstRuntime.execute(command);

  const reopenedRuntime = new FeishuRuntime(
    { send: vi.fn<FeishuClient["send"]>() },
    new SqliteIdempotencyStore(ledgerPath),
  );
  expect(await reopenedRuntime.execute(command)).toMatchObject({
    error: {
      code: "SERVER_REJECTED",
      causeCode: "FEISHU_230101",
      retryable: false,
    },
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("redacts invalid provider codes before returning or persisting them", async () => {
  const send = vi.fn<FeishuClient["send"]>().mockResolvedValue({
    status: "rejected",
    code: "secret delivery token with spaces",
  });
  const app = await runtime(send);
  const first = await app.execute(command);
  const duplicate = await app.execute(command);

  expect(first).toMatchObject({
    error: {
      code: "SERVER_REJECTED",
      causeCode: "UPSTREAM_CODE_REDACTED",
      retryable: false,
    },
  });
  expect(duplicate).toEqual(first);
  expect(JSON.stringify(first)).not.toContain("secret delivery token");
  expect(send).toHaveBeenCalledTimes(1);
});
