import { createHash, randomUUID } from "node:crypto";

import type { IlinkSendRequest, RuntimeDependencies } from "./ports.js";
import type { IdempotencyEntry } from "./state.js";

const RENEWAL_AFTER_MS = 22 * 60 * 60 * 1000;
const BLOCK_AFTER_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT_CODE_POINTS = 4000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const DELIVERY_CAPACITY = 100;

export type SessionState =
  | "not_logged_in"
  | "awaiting_message"
  | "ready"
  | "renewal_due"
  | "blocked"
  | "auth_stale";

export type StatusCommand = { type: "status"; requestId: string };
export type SendTextCommand = {
  type: "send-text";
  requestId: string;
  idempotencyKey: string;
  text: string;
  purpose?: "user" | "reminder" | "connection";
};
export type SendFileCommand = {
  type: "send-file";
  requestId: string;
  idempotencyKey: string;
  stagedPath: string;
  fileName: string;
  byteLength: number;
  contentSha256: string;
};
export type SendCommand = SendTextCommand | SendFileCommand;
export type RuntimeCommand = StatusCommand | SendCommand;

export type RuntimeSuccess = {
  ok: true;
  command: "status";
  requestId: string;
  result: {
    state: SessionState;
    boundAt: string | null;
    lastInboundAt: string | null;
    renewalDueAt: string | null;
    expiresAt: string | null;
  };
};

export type SendSuccess = {
  ok: true;
  command: "send";
  requestId: string;
  result: {
    state: "accepted";
    idempotencyKey: string;
    clientMessageId: string;
    deduplicated: boolean;
  };
};

export type RuntimeFailure = {
  ok: false;
  command: "send";
  requestId: string;
  idempotencyKey: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    causeCode?: string;
  };
};

export type RuntimeResponse = RuntimeSuccess | SendSuccess | RuntimeFailure;

export class RuntimeApplication {
  private deliveryTail: Promise<void> = Promise.resolve();
  private queuedDeliveries = 0;

  public constructor(private readonly dependencies: RuntimeDependencies) {}

  public isDeliveryIdle(): boolean {
    return this.queuedDeliveries === 0;
  }

  public async execute(command: RuntimeCommand): Promise<RuntimeResponse> {
    if (command.type !== "status") return this.enqueue(command);
    const [persisted, secret] = await Promise.all([
      this.dependencies.stateStore.load(),
      this.dependencies.credentialStore.load(),
    ]);
    if (persisted === null || secret === null) {
      return this.statusResult(command, "not_logged_in", null, null);
    }
    if (persisted.authStale) {
      return this.statusResult(
        command,
        "auth_stale",
        persisted.binding.boundAt,
        persisted.lastInboundAt,
      );
    }
    if (persisted.lastInboundAt === null || secret.contextToken === null) {
      return this.statusResult(
        command,
        "awaiting_message",
        persisted.binding.boundAt,
        persisted.lastInboundAt,
      );
    }
    const age = Math.max(
      0,
      this.dependencies.clock.now() - persisted.lastInboundAt,
    );
    const state: SessionState =
      age >= BLOCK_AFTER_MS
        ? "blocked"
        : age >= RENEWAL_AFTER_MS
          ? "renewal_due"
          : "ready";
    return this.statusResult(
      command,
      state,
      persisted.binding.boundAt,
      persisted.lastInboundAt,
    );
  }

  private enqueue(command: SendCommand): Promise<SendSuccess | RuntimeFailure> {
    if (this.queuedDeliveries >= DELIVERY_CAPACITY) {
      return Promise.resolve(
        this.failure(
          command,
          "BUSY",
          "The delivery queue is full.",
          undefined,
          true,
        ),
      );
    }
    this.queuedDeliveries += 1;
    const result = this.deliveryTail.then(() => this.send(command));
    this.deliveryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.queuedDeliveries -= 1;
    });
  }

  private async send(
    command: SendCommand,
  ): Promise<SendSuccess | RuntimeFailure> {
    const validationFailure = this.validate(command);
    if (validationFailure !== null) return validationFailure;

    const [persisted, secret] = await Promise.all([
      this.dependencies.stateStore.load(),
      this.dependencies.credentialStore.load(),
    ]);
    if (persisted === null || secret === null) {
      return this.failure(command, "NOT_LOGGED_IN", "Weixin is not logged in.");
    }
    if (persisted.authStale) {
      return this.failure(
        command,
        "AUTH_STALE",
        "Weixin login credentials are stale.",
      );
    }
    if (persisted.lastInboundAt === null || secret.contextToken === null) {
      return this.failure(
        command,
        "AWAITING_MESSAGE",
        "Send a message to the bound ClawBot before sending.",
      );
    }
    if (
      this.dependencies.clock.now() - persisted.lastInboundAt >=
      BLOCK_AFTER_MS
    ) {
      return this.failure(
        command,
        "SESSION_EXPIRED",
        "The Weixin session has expired; send a fresh inbound message first.",
      );
    }

    const payloadHash = this.payloadHash(command);
    const payloadType =
      command.type === "send-file"
        ? "file"
        : command.purpose === "reminder"
          ? "reminder"
          : "text";
    await this.dependencies.idempotencyStore.pruneBefore(
      this.dependencies.clock.now() - IDEMPOTENCY_RETENTION_MS,
    );
    const existing = await this.dependencies.idempotencyStore.find(
      command.idempotencyKey,
    );
    if (existing !== null)
      return this.replayExisting(command, existing, payloadHash, payloadType);

    const entry: IdempotencyEntry = {
      key: command.idempotencyKey,
      payloadType,
      payloadHash,
      status: "pending",
      createdAt: this.dependencies.clock.now(),
      resultCode: "PENDING",
      clientMessageId: null,
    };
    await this.dependencies.idempotencyStore.insert(entry);

    const startedAt = this.dependencies.clock.now();
    let outcome: Awaited<ReturnType<RuntimeDependencies["ilink"]["send"]>>;
    try {
      outcome = await this.dependencies.ilink.send({
        binding: persisted.binding,
        secret,
        payload: this.ilinkPayload(command),
        clientId: randomUUID(),
      });
    } catch {
      outcome = { status: "unknown", code: "NETWORK_RESULT_UNKNOWN" };
    }

    if (outcome.status === "accepted") {
      entry.status = "accepted";
      entry.resultCode = "ACCEPTED";
      entry.clientMessageId = outcome.clientMessageId;
      await this.dependencies.idempotencyStore
        .update(entry)
        .catch(() => undefined);
      await this.writeAudit(command, "ACCEPTED", startedAt).catch(
        () => undefined,
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
    if (outcome.code === "ILINK_RET_-14") {
      entry.status = "rejected";
      entry.resultCode = "AUTH_STALE";
      persisted.authStale = true;
      await Promise.all([
        this.dependencies.idempotencyStore.update(entry).catch(() => undefined),
        this.dependencies.stateStore.save(persisted).catch(() => undefined),
        this.writeAudit(command, "AUTH_STALE", startedAt).catch(
          () => undefined,
        ),
      ]);
      return this.failure(
        command,
        "AUTH_STALE",
        "Weixin login credentials are stale.",
        outcome.code,
      );
    }
    if (outcome.status === "rejected") {
      entry.status = "rejected";
      entry.resultCode = "SERVER_REJECTED";
      await this.dependencies.idempotencyStore
        .update(entry)
        .catch(() => undefined);
      await this.writeAudit(command, "SERVER_REJECTED", startedAt).catch(
        () => undefined,
      );
      return this.failure(
        command,
        "SERVER_REJECTED",
        "Weixin rejected the send request.",
        outcome.code,
      );
    }
    if (outcome.status === "failed") {
      entry.status = "rejected";
      entry.resultCode = "PRE_SEND_FAILED";
      await this.dependencies.idempotencyStore
        .update(entry)
        .catch(() => undefined);
      await this.writeAudit(command, "PRE_SEND_FAILED", startedAt).catch(
        () => undefined,
      );
      return this.failure(
        command,
        "PRE_SEND_FAILED",
        "The request failed before sendmessage began.",
        outcome.code,
      );
    }
    entry.status = "unknown";
    entry.resultCode = outcome.code;
    await this.dependencies.idempotencyStore
      .update(entry)
      .catch(() => undefined);
    await this.writeAudit(command, "RESULT_UNKNOWN", startedAt).catch(
      () => undefined,
    );
    return this.failure(
      command,
      "RESULT_UNKNOWN",
      "The send result is unknown and will not be retried automatically.",
    );
  }

  private validate(command: SendCommand): RuntimeFailure | null {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(command.idempotencyKey)) {
      return this.failure(
        command,
        "INVALID_IDEMPOTENCY_KEY",
        "The idempotency key must contain 1-128 safe ASCII characters.",
      );
    }
    if (command.type === "send-text") {
      const codePoints = Array.from(command.text).length;
      if (codePoints === 0 || codePoints > MAX_TEXT_CODE_POINTS) {
        return this.failure(
          command,
          "INVALID_TEXT",
          `Text must contain 1-${MAX_TEXT_CODE_POINTS} Unicode characters.`,
        );
      }
      return null;
    }
    if (
      command.byteLength <= 0 ||
      command.byteLength > MAX_FILE_BYTES ||
      !Number.isSafeInteger(command.byteLength)
    ) {
      return this.failure(
        command,
        "INVALID_FILE_SIZE",
        "The file size is unsupported.",
      );
    }
    if (
      command.fileName !== command.fileName.split(/[\\/]/).at(-1) ||
      /[\u0000-\u001f\u007f]/.test(command.fileName) ||
      Buffer.byteLength(command.fileName, "utf8") > 255
    ) {
      return this.failure(
        command,
        "INVALID_FILE_NAME",
        "The file name is unsafe.",
      );
    }
    if (
      !/^[a-f0-9]{64}$/.test(command.contentSha256) ||
      command.stagedPath === ""
    ) {
      return this.failure(
        command,
        "INVALID_FILE",
        "The staged file metadata is invalid.",
      );
    }
    return null;
  }

  private payloadHash(command: SendCommand): string {
    const hash = createHash("sha256");
    if (command.type === "send-text") {
      const purpose =
        command.purpose === "reminder"
          ? "reminder"
          : command.purpose === "connection"
            ? "connection"
            : "text";
      return hash.update(`${purpose}\0`).update(command.text).digest("hex");
    }
    return hash
      .update("file\0")
      .update(command.fileName)
      .update("\0")
      .update(command.contentSha256)
      .digest("hex");
  }

  private ilinkPayload(command: SendCommand): IlinkSendRequest["payload"] {
    return command.type === "send-text"
      ? { type: "text", text: command.text }
      : {
          type: "file",
          stagedPath: command.stagedPath,
          fileName: command.fileName,
          byteLength: command.byteLength,
        };
  }

  private replayExisting(
    command: SendCommand,
    existing: IdempotencyEntry,
    payloadHash: string,
    payloadType: "text" | "file" | "reminder",
  ): SendSuccess | RuntimeFailure {
    if (
      existing.payloadType !== payloadType ||
      existing.payloadHash !== payloadHash
    ) {
      return this.failure(
        command,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different payload.",
      );
    }
    if (existing.status === "accepted" && existing.clientMessageId !== null) {
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
    }
    if (existing.status === "rejected") {
      if (existing.resultCode === "AUTH_STALE") {
        return this.failure(
          command,
          "AUTH_STALE",
          "The original request found stale Weixin credentials.",
        );
      }
      return existing.resultCode === "PRE_SEND_FAILED"
        ? this.failure(
            command,
            "PRE_SEND_FAILED",
            "The original request failed before sendmessage began.",
          )
        : this.failure(
            command,
            "SERVER_REJECTED",
            "Weixin rejected the original send request.",
          );
    }
    return this.failure(
      command,
      "RESULT_UNKNOWN",
      "The original send result is unknown and will not be retried automatically.",
    );
  }

  private failure(
    command: SendCommand,
    code: string,
    message: string,
    causeCode?: string,
    retryable = false,
  ): RuntimeFailure {
    return {
      ok: false,
      command: "send",
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      error: {
        code,
        message,
        retryable,
        ...(causeCode === undefined ? {} : { causeCode }),
      },
    };
  }

  private async writeAudit(
    command: SendCommand,
    resultCode: string,
    startedAt: number,
  ): Promise<void> {
    await this.dependencies.audit.write({
      timestamp: new Date(this.dependencies.clock.now()).toISOString(),
      requestId: command.requestId,
      event: "send_finished",
      payloadType:
        command.type === "send-file"
          ? "file"
          : command.purpose === "reminder"
            ? "reminder"
            : "text",
      byteSize:
        command.type === "send-text"
          ? Buffer.byteLength(command.text, "utf8")
          : command.byteLength,
      latencyMs: Math.max(0, this.dependencies.clock.now() - startedAt),
      resultCode,
    });
  }

  private statusResult(
    command: StatusCommand,
    state: SessionState,
    boundAt: string | null,
    lastInboundAt: number | null,
  ): RuntimeSuccess {
    return {
      ok: true,
      command: "status",
      requestId: command.requestId,
      result: {
        state,
        boundAt,
        lastInboundAt:
          lastInboundAt === null ? null : new Date(lastInboundAt).toISOString(),
        renewalDueAt:
          lastInboundAt === null
            ? null
            : new Date(lastInboundAt + RENEWAL_AFTER_MS).toISOString(),
        expiresAt:
          lastInboundAt === null
            ? null
            : new Date(lastInboundAt + BLOCK_AFTER_MS).toISOString(),
      },
    };
  }
}
