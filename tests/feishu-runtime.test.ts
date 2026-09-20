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
