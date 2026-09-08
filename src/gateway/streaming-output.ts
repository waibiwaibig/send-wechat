import { randomUUID } from "node:crypto";

export type SendGatewayText = (
  text: string,
  idempotencyKey: string,
) => Promise<void>;

export type StreamingOutputOptions = {
  send: SendGatewayText;
  onError: (code: string) => void;
  idleMs?: number;
  minChars?: number;
  maxChars?: number;
};

/** One submitted send at a time; invalidation drops every unsubmitted old block. */
export class StreamingOutput {
  private readonly runId = randomUUID();
  private epoch = 0;
  private sequence = 0;
  private buffer = "";
  private queue: Array<{ epoch: number; text: string }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private blocked = false;
  private closed = false;

  public constructor(private readonly options: StreamingOutputOptions) {
    for (const value of [options.minChars ?? 200, options.maxChars ?? 1000]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError("Invalid streaming chunk size");
    }
    if (
      !Number.isFinite(options.idleMs ?? 1000) ||
      (options.idleMs ?? 1000) < 0
    ) {
      throw new RangeError("Invalid streaming interval");
    }
  }

  public begin(): number {
    this.epoch += 1;
    this.buffer = "";
    this.queue = [];
    this.blocked = false;
    this.clearTimer();
    return this.epoch;
  }

  public append(epoch: number, text: string): void {
    if (epoch !== this.epoch || this.blocked || this.closed || text === "")
      return;
    this.buffer += text;
    if (
      this.buffer.length +
        this.queue.reduce((size, part) => size + part.text.length, 0) >
      128 * 1024
    ) {
      this.fail("GATEWAY_OUTPUT_OVERFLOW");
      return;
    }
    const min = this.options.minChars ?? 200;
    if (Array.from(this.buffer).length >= min) this.cut(false);
    if (this.buffer !== "" && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.cut(true);
      }, this.options.idleMs ?? 1000);
      this.timer.unref();
    }
  }

  public flush(epoch: number): void {
    if (epoch !== this.epoch || this.blocked || this.closed) return;
    this.clearTimer();
    this.cut(true);
  }

  public async settled(): Promise<void> {
    while (this.inFlight !== undefined) await this.inFlight;
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.begin();
    await this.settled();
  }

  private cut(force: boolean): void {
    const max = Math.min(4000, this.options.maxChars ?? 1000);
    const min = this.options.minChars ?? 200;
    let characters = Array.from(this.buffer);
    while (characters.length > 0 && (force || characters.length >= min)) {
      let end = Math.min(max, characters.length);
      // Prefer a readable sentence/paragraph boundary without splitting a Unicode character.
      for (let index = end - 1; index >= Math.min(min, end) - 1; index -= 1) {
        if (/[\n。！？.!?]/u.test(characters[index] ?? "")) {
          end = index + 1;
          break;
        }
      }
      const text = characters.slice(0, end).join("");
      characters = characters.slice(end);
      if (text.trim() !== "") this.queue.push({ epoch: this.epoch, text });
    }
    this.buffer = characters.join("");
    this.pump();
  }

  private pump(): void {
    if (this.inFlight !== undefined || this.blocked || this.closed) return;
    const part = this.queue.shift();
    if (part === undefined) return;
    if (part.epoch !== this.epoch) {
      this.pump();
      return;
    }
    const key = `gateway:${this.runId}:${part.epoch}:${++this.sequence}`;
    this.inFlight = Promise.resolve()
      .then(() => {
        if (part.epoch !== this.epoch || this.closed) return;
        return this.options.send(part.text, key);
      })
      .catch(() => {
        // Once handed to the transport, an ambiguous result must never be replayed.
        if (part.epoch === this.epoch)
          this.fail("GATEWAY_SEND_FAILED_OR_UNKNOWN");
      })
      .finally(() => {
        this.inFlight = undefined;
        this.pump();
      });
  }

  private fail(code: string): void {
    this.blocked = true;
    this.buffer = "";
    this.queue = [];
    this.clearTimer();
    this.options.onError(code);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
