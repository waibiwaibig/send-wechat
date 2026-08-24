import { appendFile, chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AuditEvent, AuditPort } from "../runtime/ports.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type JsonAuditLogOptions = {
  directory: string;
  now?: () => number;
  maximumBytes?: number;
};

export class UnsafeAuditEventError extends Error {
  public constructor() {
    super("UNSAFE_AUDIT_EVENT");
    this.name = "UnsafeAuditEventError";
  }
}

export class JsonAuditLog implements AuditPort {
  private readonly now: () => number;
  private readonly maximumBytes: number;

  public constructor(private readonly options: JsonAuditLogOptions) {
    this.now = options.now ?? Date.now;
    this.maximumBytes = options.maximumBytes ?? 10 * 1024 * 1024;
  }

  public async write(event: AuditEvent): Promise<void> {
    validateEvent(event);
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32")
      await chmod(this.options.directory, 0o700);
    await this.prune();

    const date = new Date(this.now()).toISOString().slice(0, 10);
    const filePath = join(this.options.directory, `send-wechat-${date}.jsonl`);
    const line = `${JSON.stringify({
      timestamp: event.timestamp,
      request_id: event.requestId,
      event: event.event,
      payload_type: event.payloadType,
      byte_size: event.byteSize,
      latency_ms: event.latencyMs,
      result_code: event.resultCode,
    })}\n`;

    await this.makeRoom(Buffer.byteLength(line), filePath);
    await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(filePath, 0o600);
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - RETENTION_MS;
    const entries = await this.logFiles();
    await Promise.all(
      entries
        .filter((entry) => entry.timestamp < cutoff)
        .map((entry) => rm(entry.path, { force: true })),
    );
  }

  private async makeRoom(
    incomingBytes: number,
    currentFile: string,
  ): Promise<void> {
    if (incomingBytes > this.maximumBytes) throw new UnsafeAuditEventError();
    const entries = await this.logFiles();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort(
      (left, right) => left.timestamp - right.timestamp,
    )) {
      if (total + incomingBytes <= this.maximumBytes) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
    if (total + incomingBytes > this.maximumBytes) {
      await rm(currentFile, { force: true });
    }
  }

  private async logFiles(): Promise<
    Array<{ path: string; size: number; timestamp: number }>
  > {
    let names: string[];
    try {
      names = await readdir(this.options.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const matching = names.filter((name) =>
      /^send-wechat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name),
    );
    return Promise.all(
      matching.map(async (name) => {
        const path = join(this.options.directory, name);
        const metadata = await stat(path);
        const datePart = name.slice(
          "send-wechat-".length,
          "send-wechat-YYYY-MM-DD".length,
        );
        return {
          path,
          size: metadata.size,
          timestamp: Date.parse(`${datePart}T00:00:00.000Z`),
        };
      }),
    );
  }
}

function validateEvent(event: AuditEvent): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.timestamp) ||
    !/^[a-z][a-z0-9_]{0,39}$/.test(event.event) ||
    (event.payloadType !== null &&
      event.payloadType !== "text" &&
      event.payloadType !== "file" &&
      event.payloadType !== "reminder") ||
    (event.resultCode !== null &&
      !/^[A-Z][A-Z0-9_-]{0,63}$/.test(event.resultCode)) ||
    (event.requestId !== null &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(event.requestId)) ||
    (event.byteSize !== null &&
      (!Number.isSafeInteger(event.byteSize) || event.byteSize < 0)) ||
    (event.latencyMs !== null &&
      (!Number.isSafeInteger(event.latencyMs) || event.latencyMs < 0))
  ) {
    throw new UnsafeAuditEventError();
  }
}
