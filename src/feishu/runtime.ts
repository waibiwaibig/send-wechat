import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import type {
  RuntimeCommand,
  RuntimeResponse,
  RuntimeFailure,
  SendCommand,
} from "../runtime/application.js";
import type { IdempotencyStore } from "../runtime/ports.js";
import type { IdempotencyEntry } from "../runtime/state.js";
import type { FeishuClient } from "./client.js";

export class FeishuRuntime {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastAttemptAt = 0;
  constructor(
    private readonly client: Pick<FeishuClient, "send">,
    private readonly ledger: IdempotencyStore,
  ) {}
  async execute(command: RuntimeCommand): Promise<RuntimeResponse> {
    if (command.type === "status")
      return {
        ok: true,
        command: "status",
        requestId: command.requestId,
        result: {
          state: "ready",
          boundAt: null,
          lastInboundAt: null,
          renewalDueAt: null,
          expiresAt: null,
        },
      };
    if (this.queued >= 100) return this.failure(command, "BUSY");
    this.queued++;
    const result = this.tail.then(() => this.send(command));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.queued--;
    });
  }
  private failure(command: SendCommand, code: string): RuntimeFailure {
    return {
      ok: false,
      command: "send",
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      error: { code, message: code, retryable: false },
    };
  }
  private async send(command: SendCommand): Promise<RuntimeResponse> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(command.idempotencyKey))
      return this.failure(command, "INVALID_IDEMPOTENCY_KEY");
    const payloadType = command.type === "send-text" ? "text" : "file";
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify(
          command.type === "send-text"
            ? ["text", command.text]
            : [
                command.mediaKind ?? "file",
                command.fileName,
                command.contentSha256,
              ],
        ),
      )
      .digest("hex");
    await this.ledger.pruneBefore(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const existing = await this.ledger.find(command.idempotencyKey);
    if (existing !== null) {
      if (
        existing.payloadHash !== payloadHash ||
        existing.payloadType !== payloadType
      )
        return this.failure(command, "IDEMPOTENCY_CONFLICT");
      if (existing.status === "accepted" && existing.clientMessageId !== null)
        return {
          ok: true,
          command: "send",
          requestId: command.requestId,
          result: {
            state: "accepted",
            idempotencyKey: command.idempotencyKey,
            clientMessageId: existing.clientMessageId,
            deduplicated: true,
          },
        };
      return this.failure(
        command,
        existing.status === "rejected" ? existing.resultCode : "RESULT_UNKNOWN",
      );
    }
    const entry: IdempotencyEntry = {
      key: command.idempotencyKey,
      payloadType,
      payloadHash,
      status: "pending",
      createdAt: Date.now(),
      resultCode: "PENDING",
      clientMessageId: null,
    };
    await this.ledger.insert(entry);
    let outcome: Awaited<ReturnType<FeishuClient["send"]>>;
    try {
      const wait = 250 - (Date.now() - this.lastAttemptAt);
      if (wait > 0) await delay(wait);
      this.lastAttemptAt = Date.now();
      outcome = await this.client.send(
        command.type === "send-text"
          ? { type: "text", text: command.text }
          : {
              type: command.mediaKind ?? "file",
              stagedPath: command.stagedPath,
              fileName: command.fileName,
              byteLength: command.byteLength,
            },
        randomUUID(),
      );
    } catch {
      outcome = { status: "unknown", code: "RESULT_UNKNOWN" };
    }
    if (outcome.status === "accepted") {
      entry.status = "accepted";
      entry.clientMessageId = outcome.clientMessageId;
      entry.resultCode = "ACCEPTED";
    } else {
      entry.status = outcome.status === "unknown" ? "unknown" : "rejected";
      entry.resultCode =
        outcome.status === "unknown"
          ? "RESULT_UNKNOWN"
          : outcome.status === "failed"
            ? "PRE_SEND_FAILED"
            : "SERVER_REJECTED";
    }
    await this.ledger.update(entry).catch(() => undefined);
    if (outcome.status !== "accepted")
      return this.failure(command, entry.resultCode);
    return {
      ok: true,
      command: "send",
      requestId: command.requestId,
      result: {
        state: "accepted",
        idempotencyKey: command.idempotencyKey,
        clientMessageId: outcome.clientMessageId,
        deduplicated: false,
      },
    };
  }
}
