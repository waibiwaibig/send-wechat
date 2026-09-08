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
    output.flush(epoch);
    await output.settled();

    expect(sent.map(({ text }) => text)).toEqual(["😀a", "界b"]);
    expect(sent.every(({ text }) => Array.from(text).length <= 2)).toBe(true);
    expect(sent.every(({ text }) => !/[\uD800-\uDFFF]/u.test(text))).toBe(true);
    expect(new Set(sent.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(
      2,
    );
  });

  it("does not send an unfinished short output after the idle timer", async () => {
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
    expect(sent).toEqual([]);
    output.flush(epoch);
    await output.settled();

    expect(sent).toEqual(["short"]);
  });

  it("sends a short completed sentence when the idle timer fires", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      idleMs: 50,
    });
    const epoch = output.begin();

    output.append(epoch, "短句。");
    await vi.advanceTimersByTimeAsync(50);
    await output.settled();

    expect(sent).toEqual(["短句。"]);
  });

  it("sends a short English question when the idle timer fires", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      idleMs: 50,
    });
    const epoch = output.begin();

    output.append(epoch, "Ready?");
    await vi.advanceTimersByTimeAsync(50);
    await output.settled();

    expect(sent).toEqual(["Ready?"]);
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

  it("preserves completion boundaries across multiple messages in one epoch", async () => {
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      maxChars: 100,
    });
    const epoch = output.begin();

    output.append(epoch, "第一条。");
    output.flush(epoch);
    output.append(epoch, "第二条。");
    output.flush(epoch);
    await output.settled();

    expect(sent).toEqual(["第一条。", "第二条。"]);
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
    output.flush(epoch);
    await output.settled();
    output.append(epoch, "retry");

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

  it("holds paths and Markdown fragments across idle pauses until a sentence ends", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      idleMs: 50,
    });
    const epoch = output.begin();
    const first =
      "截图已保存到 /tmp/screenshots/shot.png，命令是 `open /tmp/shot.png`，";
    const second = "这是 **加粗说明。** 请稍后查看。";

    output.append(epoch, first);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual([]);

    output.append(epoch, second);
    await output.settled();

    expect(sent).toEqual([first + second]);
  });

  it("prefers complete sentences and paragraphs while keeping the soft bound", async () => {
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      maxChars: 11,
    });
    const epoch = output.begin();
    const input = "第一段需要完整结束。第二段也需要完整结束！第三段完成。";

    output.append(epoch, input);
    output.flush(epoch);
    await output.settled();

    expect(sent).toEqual([
      "第一段需要完整结束。",
      "第二段也需要完整结束！",
      "第三段完成。",
    ]);
    expect(sent.every((text) => Array.from(text).length <= 11)).toBe(true);
  });

  it("does not treat URL, path, or decimal dots as sentence boundaries", async () => {
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      maxChars: 1000,
    });
    const epoch = output.begin();
    const input =
      "数值是 1.23，路径是 /tmp/shot.png，网页是 https://example.com/a.b。完成。";

    output.append(epoch, input);
    await output.settled();

    expect(sent).toEqual([input]);
  });

  it("makes progress on long unpunctuated Unicode output without splitting code points", async () => {
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      maxChars: 5000,
    });
    const epoch = output.begin();
    const input = "😀".repeat(10_000);

    output.append(epoch, input);
    await waitFor(() => sent.length === 2);
    expect(sent.length).toBe(2);
    expect(sent.every((text) => Array.from(text).length <= 4000)).toBe(true);
    output.flush(epoch);
    await output.settled();

    expect(sent.join("")).toBe(input);
    expect(sent.map((text) => Array.from(text).length)).toEqual([
      4000, 4000, 2000,
    ]);
    expect(sent.every((text) => !/[\uD800-\uDFFF]/u.test(text))).toBe(true);
  });

  it("coalesces queued complete blocks behind a slow transport", async () => {
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
      maxChars: 30,
    });
    const epoch = output.begin();

    output.append(epoch, "第一句。");
    await waitFor(() => sendCalls === 1);
    output.append(epoch, "第二句。");
    output.append(epoch, "第三句。");
    output.flush(epoch);
    releaseFirst();
    await output.settled();

    expect(sent).toEqual(["第一句。", "第二句。第三句。"]);
  });

  it("keeps a fenced code block intact when it can finish below the hard bound", async () => {
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      maxChars: 40,
    });
    const epoch = output.begin();
    const code = "```ts\nconst value = 1.23;\n```\n\n";
    const prose = "代码块结束后继续发送完整说明。";
    const input = code + prose;

    output.append(epoch, input);
    await output.settled();

    expect(sent).toEqual([code, prose]);
  });

  it("buffers complete-message mode without timers or length-triggered sends", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      idleMs: 1,
      minChars: 1,
      maxChars: 1,
    });
    const epoch = output.begin(false);
    const input = "x".repeat(10_000);

    output.append(epoch, input);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([]);

    output.flush(epoch);
    await output.settled();
    expect(sent.join("")).toBe(input);
    expect(sent).toHaveLength(3);
    expect(sent.every((text) => Array.from(text).length <= 4000)).toBe(true);
  });

  it("keeps completed messages separate in complete-message mode", async () => {
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      maxChars: 1,
    });
    const epoch = output.begin(false);

    output.append(epoch, "progress");
    output.flush(epoch);
    output.append(epoch, "answer");
    output.flush(epoch);
    await output.settled();

    expect(sent).toEqual(["progress", "answer"]);
  });

  it("snapshots stream mode at begin and invalidates old buffered output", async () => {
    const sent: string[] = [];
    const { output } = makeOutput({
      send: async (text) => {
        sent.push(text);
      },
      minChars: 1,
      maxChars: 1,
    });
    const oldEpoch = output.begin(false);
    output.append(oldEpoch, "old");
    const newEpoch = output.begin(true);
    output.append(newEpoch, "new");
    output.flush(newEpoch);
    await output.settled();

    expect(sent).toEqual(["n", "e", "w"]);
  });
});
