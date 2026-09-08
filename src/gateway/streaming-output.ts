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

const DEFAULT_IDLE_MS = 3000;
const DEFAULT_MIN_CHARS = 200;
const DEFAULT_MAX_CHARS = 1000;
const HARD_MAX_CHARS = 4000;

type QueuedPart = { epoch: number; text: string; complete: boolean };
type ProtectedRange = { start: number; end: number };

const sentenceSegmenter = new Intl.Segmenter(undefined, {
  granularity: "sentence",
});

/** One submitted send at a time; invalidation drops every unsubmitted old block. */
export class StreamingOutput {
  private readonly runId = randomUUID();
  private epoch = 0;
  private sequence = 0;
  private streamEnabled = true;
  private buffer = "";
  private queue: QueuedPart[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private blocked = false;
  private closed = false;

  public constructor(private readonly options: StreamingOutputOptions) {
    for (const value of [
      options.minChars ?? DEFAULT_MIN_CHARS,
      options.maxChars ?? DEFAULT_MAX_CHARS,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError("Invalid streaming chunk size");
    }
    if (
      !Number.isFinite(options.idleMs ?? DEFAULT_IDLE_MS) ||
      (options.idleMs ?? DEFAULT_IDLE_MS) < 0
    ) {
      throw new RangeError("Invalid streaming interval");
    }
  }

  public begin(streamEnabled = true): number {
    this.epoch += 1;
    this.streamEnabled = streamEnabled;
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
    if (!this.streamEnabled) return;
    this.clearTimer();
    this.cut(false);
    this.scheduleTimer();
  }

  /** Marks the current message complete; later appends in this epoch start a new boundary. */
  public flush(epoch: number): void {
    if (epoch !== this.epoch || this.blocked || this.closed) return;
    this.clearTimer();
    if (this.streamEnabled) this.cut(true);
    else this.cutCompletedMessage();
    const last = this.queue.at(-1);
    if (last !== undefined && last.epoch === this.epoch) last.complete = true;
  }

  public async settled(): Promise<void> {
    while (this.inFlight !== undefined) await this.inFlight;
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.begin();
    await this.settled();
  }

  private cut(force: boolean, allowShortNatural = false): void {
    const max = Math.min(
      HARD_MAX_CHARS,
      this.options.maxChars ?? DEFAULT_MAX_CHARS,
    );
    const min = allowShortNatural
      ? 1
      : Math.min(max, this.options.minChars ?? DEFAULT_MIN_CHARS);
    let characters = Array.from(this.buffer);
    while (characters.length > 0) {
      const end = force
        ? this.findCompletedCut(characters, min, max)
        : this.findStreamingCut(characters, min, max);
      if (end === undefined) break;
      const text = characters.slice(0, end).join("");
      characters = characters.slice(end);
      if (text.trim() !== "") this.enqueue(text, max);
    }
    this.buffer = characters.join("");
    this.pump();
  }

  /** Complete-message mode keeps a message in one bubble whenever it fits. */
  private cutCompletedMessage(): void {
    const max = HARD_MAX_CHARS;
    let characters = Array.from(this.buffer);
    while (characters.length > 0) {
      const end =
        characters.length <= max
          ? characters.length
          : (this.findNaturalBoundaries(characters, 1, max).at(-1) ?? max);
      const text = characters.slice(0, end).join("");
      characters = characters.slice(end);
      if (text.trim() !== "") this.enqueue(text, max);
    }
    this.buffer = "";
    this.pump();
  }

  private findStreamingCut(
    characters: string[],
    min: number,
    max: number,
  ): number | undefined {
    if (characters.length < min) return undefined;
    const natural = this.findNaturalBoundaries(characters, min, max);
    const boundary = natural.at(-1);
    if (boundary !== undefined) return boundary;
    return characters.length >= max ? max : undefined;
  }

  private findCompletedCut(
    characters: string[],
    min: number,
    max: number,
  ): number | undefined {
    const natural = this.findNaturalBoundaries(characters, min, max);
    return (
      natural.at(-1) ?? (characters.length <= max ? characters.length : max)
    );
  }

  private findNaturalBoundaries(
    characters: string[],
    min: number,
    max: number,
  ): number[] {
    const text = characters.join("");
    const mask = markdownProtection(characters);
    const candidates = new Set<number>();
    const add = (end: number): void => {
      if (
        end >= min &&
        end <= max &&
        characters.slice(0, end).some((character) => !/\s/u.test(character))
      )
        candidates.add(end);
    };

    for (let index = 0; index < characters.length; index += 1) {
      if (mask[index]) continue;
      if (characters[index] === "\n") {
        let end = index + 1;
        while (characters[end] === "\n") end += 1;
        if (end - index >= 2) add(end);
        index = end - 1;
      }
    }

    for (const segment of sentenceSegmenter.segment(text)) {
      const end = Array.from(
        text.slice(0, segment.index + segment.segment.length),
      ).length;
      if (end >= min && end <= max && isSafeSegmentEnd(characters, end, mask))
        add(end);
    }
    return [...candidates].sort((left, right) => left - right);
  }

  private enqueue(text: string, max: number): void {
    const last = this.queue.at(-1);
    if (
      last !== undefined &&
      last.epoch === this.epoch &&
      !last.complete &&
      Array.from(last.text).length + Array.from(text).length <= max
    ) {
      last.text += text;
      return;
    }
    this.queue.push({ epoch: this.epoch, text, complete: false });
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
    if (this.blocked) return;
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

  private scheduleTimer(): void {
    if (this.buffer === "" || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.cut(false, true);
    }, this.options.idleMs ?? DEFAULT_IDLE_MS);
    this.timer.unref();
  }
}

function isPeriodBoundary(characters: string[], index: number): boolean {
  if (characters[index - 1] === "." || characters[index + 1] === ".")
    return false;
  const nextIndex = skipClosers(characters, index + 1);
  const previous = characters[index - 1];
  const next = characters[nextIndex];
  if (/\d/u.test(previous ?? "") && /\d/u.test(next ?? "")) return false;
  if (next !== undefined && /[\p{L}\p{N}_]/u.test(next)) return false;
  return !isUrlOrPathPosition(characters, index);
}

function isUrlOrPathPosition(characters: string[], index: number): boolean {
  const { start, end } = tokenBounds(characters, index);
  const token = characters.slice(start, end).join("");
  if (
    token.includes("://") ||
    token.includes("/") ||
    token.includes("\\") ||
    token.startsWith("www.")
  )
    return true;
  if (characters[index] !== ".") return false;
  const suffix = characters
    .slice(index + 1, end)
    .join("")
    .replace(/[)'\]}*]+$/u, "");
  return /^(?:png|jpe?g|gif|webp|svg|pdf|json|ya?ml|toml|tsx?|jsx?|md|txt)$/iu.test(
    suffix,
  );
}

function tokenBounds(
  characters: string[],
  index: number,
): { start: number; end: number } {
  let start = index;
  while (start > 0 && !/\s/u.test(characters[start - 1] ?? "")) start -= 1;
  let end = index + 1;
  while (end < characters.length && !/\s/u.test(characters[end] ?? ""))
    end += 1;
  return { start, end };
}

function skipClosers(characters: string[], index: number): number {
  let next = index;
  while (
    next < characters.length &&
    /[)'\]}”’》）】*]/u.test(characters[next] ?? "")
  )
    next += 1;
  return next;
}

function isSafeSegmentEnd(
  characters: string[],
  end: number,
  mask: boolean[],
): boolean {
  let index = end - 1;
  while (index >= 0 && /\s/u.test(characters[index] ?? "")) index -= 1;
  while (index >= 0 && /[)'\]}”’》）】*]/u.test(characters[index] ?? ""))
    index -= 1;
  if (index < 0 || index >= characters.length || mask[index]) return false;
  if (/[。！？]/u.test(characters[index] ?? "")) return true;
  if (characters[index] === ".") return isPeriodBoundary(characters, index);
  if (characters[index] === "!" || characters[index] === "?")
    return !isUrlOrPathPosition(characters, index);
  return false;
}

function markdownProtection(characters: string[]): boolean[] {
  const ranges: ProtectedRange[] = [];
  for (let index = 0; index < characters.length;) {
    const delimiter = characters[index];
    if (delimiter === "`") {
      const run = delimiterRun(characters, index, delimiter);
      const close = findDelimiter(characters, index + run, delimiter, run);
      const end = close === undefined ? characters.length : close + run;
      ranges.push({ start: index, end });
      if (close === undefined) break;
      index = end;
      continue;
    }
    if (
      (delimiter === "*" || delimiter === "_") &&
      characters[index + 1] === delimiter
    ) {
      const close = findDelimiter(characters, index + 2, delimiter, 2);
      const end = close === undefined ? characters.length : close + 2;
      ranges.push({ start: index, end });
      if (close === undefined) break;
      index = end;
      continue;
    }
    index += 1;
  }
  const mask = new Array<boolean>(characters.length).fill(false);
  for (const range of ranges)
    for (let index = range.start; index < range.end; index += 1)
      mask[index] = true;
  return mask;
}

function delimiterRun(
  characters: string[],
  start: number,
  delimiter: string,
): number {
  let end = start;
  while (characters[end] === delimiter) end += 1;
  return end - start;
}

function findDelimiter(
  characters: string[],
  start: number,
  delimiter: string,
  run: number,
): number | undefined {
  for (let index = start; index < characters.length; index += 1) {
    if (characters[index] !== delimiter) continue;
    const found = delimiterRun(characters, index, delimiter);
    if (found === run || (run >= 3 && found > run)) return index;
  }
  return undefined;
}
