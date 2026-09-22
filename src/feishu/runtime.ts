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

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REDACTED_CODE = "UPSTREAM_CODE_REDACTED";
const RESULT_PREFIXES = {
  failed: "FAILED_",
  rejected: "REJECTED_",
  unknown: "UNKNOWN_",
} as const;
type OutcomeStatus = keyof typeof RESULT_PREFIXES;

export type FeishuReceiveDiagnostics = {
  listener: "inactive" | "starting" | "listening" | "failed";
  lastListenerError: string | null;
  lastInboundAt: string | null;
  lastEnqueuedAt: string | null;
  lastInboundError: string | null;
  lastEventAt?: string | null;
  lastFilterReason?: string | null;
  lastProcessingError?: string | null;
};

function safeOutcomeCode(code: string, prefix: string): string {
  const maxCodeLength = 64 - prefix.length;
  return SAFE_CODE_PATTERN.test(code) && code.length <= maxCodeLength
    ? code
    : REDACTED_CODE;
}

function persistedResultCode(status: OutcomeStatus, code: string): string {
  const prefix = RESULT_PREFIXES[status];
  return `${prefix}${safeOutcomeCode(code, prefix)}`;
}

function decodedFailure(
  resultCode: string,
  status: IdempotencyEntry["status"],
): {
  code: "PRE_SEND_FAILED" | "SERVER_REJECTED" | "RESULT_UNKNOWN";
  causeCode?: string;
} {
  for (const [outcomeStatus, prefix] of Object.entries(
    RESULT_PREFIXES,
  ) as Array<[OutcomeStatus, string]>) {
    if (resultCode.startsWith(prefix)) {
      const causeCode = resultCode.slice(prefix.length);
      return {
        code:
          outcomeStatus === "failed"
            ? "PRE_SEND_FAILED"
            : outcomeStatus === "rejected"
              ? "SERVER_REJECTED"
              : "RESULT_UNKNOWN",
        causeCode: SAFE_CODE_PATTERN.test(causeCode)
          ? causeCode
          : REDACTED_CODE,
      };
    }
  }
  if (resultCode === "PRE_SEND_FAILED") return { code: "PRE_SEND_FAILED" };
  if (resultCode === "SERVER_REJECTED") return { code: "SERVER_REJECTED" };
  if (resultCode === "RESULT_UNKNOWN") return { code: "RESULT_UNKNOWN" };
  return {
    code: status === "rejected" ? "SERVER_REJECTED" : "RESULT_UNKNOWN",
  };
}

export class FeishuRuntime {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastAttemptAt = 0;
  private lastSend: {
    at: string;
    status: "accepted" | OutcomeStatus;
    code: string;
  } | null = null;
  constructor(
    private readonly client: Pick<FeishuClient, "send">,
    private readonly ledger: IdempotencyStore,
    private readonly receiveDiagnostics?: () => FeishuReceiveDiagnostics,
  ) {}
  async execute(command: RuntimeCommand): Promise<RuntimeResponse> {
    if (command.type === "status") {
      const receive = this.receiveDiagnostics?.();
      return {
        ok: true,
        command: "status",
        requestId: command.requestId,
        result: {
          state: "ready",
          boundAt: null,
          lastInboundAt: receive?.lastInboundAt ?? null,
          renewalDueAt: null,
          expiresAt: null,
          diagnostics: {
            readiness: "configured",
            ...receive,
            lastSend: this.lastSend === null ? null : { ...this.lastSend },
          },
        },
      };
    }
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
  private failure(
    command: SendCommand,
    code: string,
    causeCode?: string,
  ): RuntimeFailure {
    return {
      ok: false,
      command: "send",
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      error: {
        code,
        message: code,
        retryable: false,
        ...(causeCode === undefined ? {} : { causeCode }),
      },
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
      const decoded = decodedFailure(existing.resultCode, existing.status);
      return this.failure(command, decoded.code, decoded.causeCode);
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
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      outcome = {
        status: "unknown",
        code: typeof code === "string" ? code : "RESULT_UNKNOWN",
      };
    }
    this.lastSend = {
      at: new Date().toISOString(),
      status: outcome.status,
      code:
        outcome.status === "accepted"
          ? "ACCEPTED"
          : safeOutcomeCode(outcome.code, RESULT_PREFIXES[outcome.status]),
    };
    if (outcome.status === "accepted") {
      entry.status = "accepted";
      entry.clientMessageId = outcome.clientMessageId;
      entry.resultCode = "ACCEPTED";
    } else {
      entry.status = outcome.status === "unknown" ? "unknown" : "rejected";
      entry.resultCode = persistedResultCode(outcome.status, outcome.code);
    }
    await this.ledger.update(entry).catch(() => undefined);
    if (outcome.status !== "accepted")
      return this.failure(
        command,
        outcome.status === "unknown"
          ? "RESULT_UNKNOWN"
          : outcome.status === "failed"
            ? "PRE_SEND_FAILED"
            : "SERVER_REJECTED",
        safeOutcomeCode(outcome.code, RESULT_PREFIXES[outcome.status]),
      );
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
