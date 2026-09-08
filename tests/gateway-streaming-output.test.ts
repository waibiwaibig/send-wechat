import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamingOutput } from "../src/gateway/streaming-output.js";

const outputs: StreamingOutput[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(outputs.splice(0).map((output) => output.close()));
});

function makeOutput(options: {
  send: (text: string, idempotencyKey: string) => Promise<void>;
  idleMs?: number;
  minChars?: number;
  maxChars?: number;
}): { output: StreamingOutput; errors: string[] } {
  const errors: string[] = [];
  const output = new StreamingOutput({
    ...options,
    onError: (code) => errors.push(code),
  });
  outputs.push(output);
  return { output, errors };
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

describe("StreamingOutput", () => {
  it("chunks Unicode text on code-point boundaries within the configured bound", async () => {
    const sent: Array<{ text: string; idempotencyKey: string }> = [];
    const { output } = makeOutput({
      send: async (text, idempotencyKey) => {
        sent.push({ text, idempotencyKey });
      },
      minChars: 1,
      maxChars: 2,
    });
    const epoch = output.begin();

    output.append(epoch, "😀a界b");
    await output.settled();

    expect(sent.map(({ text }) => text)).toEqual(["😀a", "界b"]);
    expect(sent.every(({ text }) => Array.from(text).length <= 2)).toBe(true);
    expect(sent.every(({ text }) => !/[\uD800-\uDFFF]/u.test(text))).toBe(true);
    expect(new Set(sent.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(
      2,
    );
  });

  it("flushes short output after the idle timer", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      idleMs: 50,
    });
    const epoch = output.begin();

    output.append(epoch, "short");
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(49);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await output.settled();

    expect(sent).toEqual(["short"]);
  });

  it("allows an in-flight submitted part to finish while dropping later old parts after invalidation", async () => {
    const sent: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sendCalls = 0;
    const { output } = makeOutput({
      send: async (text) => {
        sendCalls += 1;
        sent.push(text);
        if (sendCalls === 1) await firstDone;
      },
      minChars: 1,
      maxChars: 1,
    });
    const firstEpoch = output.begin();

    output.append(firstEpoch, "A");
    await waitFor(() => sendCalls === 1);
    output.append(firstEpoch, "B");
    const nextEpoch = output.begin();
    releaseFirst();
    await output.settled();

    output.append(nextEpoch, "C");
    output.flush(nextEpoch);
    await output.settled();

    expect(sent).toEqual(["A", "C"]);
  });

  it("does not retry an ambiguous send and blocks the failed epoch", async () => {
    const attempts: string[] = [];
    const { output, errors } = makeOutput({
      send: async (text) => {
        attempts.push(text);
        throw new Error("transport outcome unknown");
      },
      minChars: 1,
    });
    const epoch = output.begin();

    output.append(epoch, "once");
    await output.settled();
    output.append(epoch, "retry");
    output.flush(epoch);

    expect(attempts).toEqual(["once"]);
    expect(errors).toEqual(["GATEWAY_SEND_FAILED_OR_UNKNOWN"]);
  });

  it("fails closed when buffered output exceeds the hard limit", async () => {
    const sent: string[] = [];
    const { output, errors } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 200_000,
    });
    const epoch = output.begin();

    output.append(epoch, "x".repeat(128 * 1024 + 1));

    expect(errors).toEqual(["GATEWAY_OUTPUT_OVERFLOW"]);
    expect(sent).toEqual([]);
  });
});
