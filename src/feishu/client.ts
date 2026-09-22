import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileTypeFromFile } from "file-type";

import { FeishuCli, FeishuCliError, type FeishuCliRunner } from "./cli.js";
import { uploadMedia } from "./media-upload.js";
import {
  feishuConfigurationSchema,
  type FeishuConfiguration,
} from "../messaging/config.js";

export type FeishuClientCli = Pick<FeishuCliRunner, "run" | "subscribe">;

export type FeishuPayload =
  | { type: "text"; text: string }
  | {
      type: "image" | "file";
      stagedPath: string;
      fileName: string;
      byteLength: number;
    };

export type FeishuSendResult =
  | { status: "accepted"; clientMessageId: string }
  | { status: "rejected" | "failed" | "unknown"; code: string };

export type FeishuInboundAttachment = {
  type: "image" | "file";
  key: string;
  fileName: string;
};

export type FeishuInboundMessage = {
  id: string;
  text: string;
  receivedAt: number;
  attachments: FeishuInboundAttachment[];
};

export type FeishuInboundCallback = (
  message: FeishuInboundMessage,
) => void | Promise<void>;

export type FeishuInboundDiagnostics = {
  lastEventAt: string | null;
  lastFilterReason: string | null;
  lastInboundError: string | null;
};

const MAX_TEXT_LENGTH = 4000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;

const rejected = (code: string): FeishuSendResult => ({
  status: "rejected",
  code,
});

const failed = (code: string): FeishuSendResult => ({
  status: "failed",
  code,
});

const unknown = (code: string): FeishuSendResult => ({
  status: "unknown",
  code,
});

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string")
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function receivedAt(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? parsed
    : Date.now();
}

function typedCode(error: unknown): string | null {
  if (error instanceof FeishuCliError) return error.code;
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code))
      return code;
  }
  return null;
}

function safeFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/\u0000-\u001f\u007f]/.test(value)
  );
}

function messageIdFrom(value: unknown): string | null {
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (validString(object.message_id)) return object.message_id;
    const data = object.data;
    if (data !== null && typeof data === "object") {
      const id = (data as Record<string, unknown>).message_id;
      if (validString(id)) return id;
    }
  }
  return null;
}

function sendFailureCode(error: unknown): FeishuSendResult {
  const code =
    error instanceof FeishuCliError
      ? error.code
      : error !== null && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
  if (typeof code === "string") {
    if (/^FEISHU_[A-Z0-9_]+$/.test(code)) {
      const numeric = /^FEISHU_(\d+)$/.exec(code)?.[1];
      if (
        numeric !== undefined &&
        Number(numeric) >= 500 &&
        Number(numeric) < 600
      )
        return unknown(`SEND_${code}`);
      return rejected(`SEND_${code}`);
    }
    if (code === "CLI_TIMEOUT" || code.endsWith("_TIMEOUT"))
      return unknown("SEND_CLI_TIMEOUT");
    if (code === "CLI_MALFORMED_OUTPUT")
      return unknown("SEND_MALFORMED_RESPONSE");
    if (
      code === "CLI_NOT_FOUND" ||
      code === "CLI_EXECUTION_FAILED" ||
      /^CLI_INVALID(?:_[A-Z0-9_]+)?$/.test(code)
    )
      return failed(`SEND_${code}`);
    if (/^CLI_(?:NETWORK|HTTP)_[A-Z0-9_]+$/.test(code))
      return unknown(`SEND_${code}`);
    if (/^CLI_[A-Z0-9_]+$/.test(code)) return unknown(`SEND_${code}`);
  }
  return unknown("SEND_NETWORK_RESULT_UNKNOWN");
}

class ByteLimitTransform extends Transform {
  private total = 0;

  public constructor(private readonly limit: number) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, encoding);
    this.total += buffer.length;
    if (this.total > this.limit) {
      callback(new Error("RESOURCE_TOO_LARGE"));
      return;
    }
    callback(null, buffer);
  }
}

export class FeishuClient {
  private readonly cli: FeishuClientCli;
  private subscription: { close(): void; isOpen?: () => boolean } | null = null;
  private diagnostics: FeishuInboundDiagnostics = {
    lastEventAt: null,
    lastFilterReason: null,
    lastInboundError: null,
  };

  public constructor(
    private readonly config: FeishuConfiguration,
    private readonly stateDir: string,
    cli?: FeishuClientCli,
  ) {
    this.cli = cli ?? new FeishuCli(stateDir, config.profile);
  }

  public async send(
    payload: FeishuPayload,
    clientId: string,
  ): Promise<FeishuSendResult> {
    const targetError = this.validateTarget();
    if (targetError !== null) return targetError;
    if (!validString(clientId)) return rejected("INVALID_CLIENT_ID");

    if (payload.type === "text") {
      if (payload.text.length === 0) return rejected("EMPTY_TEXT");
      if (Array.from(payload.text).length > MAX_TEXT_LENGTH)
        return rejected("TEXT_TOO_LONG");
      return this.sendCommand([
        "--text",
        payload.text,
        "--idempotency-key",
        clientId,
      ]);
    }

    const staged = await this.prepareMedia(payload);
    if ("status" in staged) return staged;
    try {
      const flag = payload.type === "image" ? "--image" : "--file";
      const uploaded = await uploadMedia(this.cli, {
        type: payload.type,
        fileName: staged.fileName,
        cwd: staged.cwd,
      });
      if ("status" in uploaded) return uploaded;
      return await this.sendCommand(
        [flag, uploaded.key, "--idempotency-key", clientId],
        staged.cwd,
      );
    } finally {
      await rm(staged.directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  public async verify(): Promise<void> {
    const targetError = this.validateTarget();
    if (targetError !== null)
      throw codedError(
        "code" in targetError ? targetError.code : "INVALID_TARGET",
      );
    try {
      await this.cli.run(["api", "GET", "/open-apis/bot/v3/info"]);
    } catch (error) {
      const code = typedCode(error);
      if (code !== null) throw codedError(code);
      throw codedError("VERIFY_NETWORK_ERROR");
    }
  }

  public async startReceiving(callback: FeishuInboundCallback): Promise<void> {
    if (this.subscription !== null) {
      if (this.subscription.isOpen?.() ?? true) return;
      this.subscription.close();
      this.subscription = null;
    }
    try {
      this.subscription = await this.cli.subscribe(async (event) => {
        try {
          await this.handleInbound(event, callback);
        } catch {
          this.diagnostics.lastInboundError = "INBOUND_PROCESSING_FAILED";
          throw new Error("INBOUND_PROCESSING_FAILED");
        }
      });
    } catch (error) {
      this.subscription = null;
      throw error;
    }
  }

  public close(): void {
    const subscription = this.subscription;
    this.subscription = null;
    subscription?.close();
  }

  public isReceiving(): boolean {
    return this.subscription?.isOpen?.() ?? this.subscription !== null;
  }

  public getInboundDiagnostics(): FeishuInboundDiagnostics {
    return { ...this.diagnostics };
  }

  public async downloadResource(
    messageId: string,
    key: string,
    type: "image" | "file",
    destination: string,
  ): Promise<void> {
    if (!validString(messageId)) throw new Error("INVALID_MESSAGE_ID");
    if (!validString(key)) throw new Error("INVALID_RESOURCE_KEY");
    if (!validString(destination)) throw new Error("INVALID_DESTINATION");

    const directory = await mkdtemp(join(this.stateDir, "feishu-download-"));
    // The upstream shortcut adds a MIME extension when the requested output
    // has none. Keep an explicit extension so the private path is stable.
    const outputName = "resource.bin";
    const outputPath = join(directory, outputName);
    try {
      await this.cli.run(
        [
          "im",
          "+messages-resources-download",
          "--message-id",
          messageId,
          "--file-key",
          key,
          "--type",
          type,
          "--output",
          `./${outputName}`,
        ],
        { cwd: directory },
      );
      const info = await lstat(outputPath);
      if (!info.isFile() || info.size > MAX_RESOURCE_BYTES)
        throw new Error(
          info.size > MAX_RESOURCE_BYTES
            ? "RESOURCE_TOO_LARGE"
            : "RESOURCE_UNREADABLE",
        );
      const input = createReadStream(outputPath);
      const output = createWriteStream(destination, {
        flags: "wx",
        mode: 0o600,
      });
      let created = false;
      output.once("open", () => {
        created = true;
      });
      try {
        await pipeline(
          input,
          new ByteLimitTransform(MAX_RESOURCE_BYTES),
          output,
        );
      } catch (error) {
        if (created) await rm(destination, { force: true });
        throw error;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private validateTarget(): FeishuSendResult | null {
    if (!validString(this.config.profile)) return failed("INVALID_PROFILE");
    if (
      this.config.receiveIdType === "open_id" &&
      (!("dmChatId" in this.config) || !validString(this.config.dmChatId))
    )
      return failed("FEISHU_REBIND_REQUIRED");
    if (!feishuConfigurationSchema.safeParse(this.config).success)
      return failed("INVALID_TARGET");
    return null;
  }

  private async prepareMedia(
    payload: Extract<FeishuPayload, { type: "image" | "file" }>,
  ): Promise<
    { cwd: string; directory: string; fileName: string } | FeishuSendResult
  > {
    const limit = payload.type === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!validString(payload.stagedPath) || !safeFileName(payload.fileName))
      return rejected("INVALID_MEDIA");
    if (!Number.isSafeInteger(payload.byteLength) || payload.byteLength <= 0)
      return rejected("INVALID_MEDIA_SIZE");
    if (payload.byteLength > limit)
      return rejected(
        payload.type === "image" ? "IMAGE_TOO_LARGE" : "FILE_TOO_LARGE",
      );

    let size: number;
    try {
      const info = await lstat(payload.stagedPath);
      if (!info.isFile()) return failed("STAGED_FILE_UNREADABLE");
      size = info.size;
    } catch {
      return failed("STAGED_FILE_UNREADABLE");
    }
    if (size !== payload.byteLength) return rejected("MEDIA_SIZE_MISMATCH");
    if (payload.type === "image") {
      try {
        if (
          !(await fileTypeFromFile(payload.stagedPath))?.mime.startsWith(
            "image/",
          )
        )
          return failed("INVALID_IMAGE");
      } catch {
        return failed("INVALID_IMAGE");
      }
    }

    let cwd: string;
    try {
      cwd = await mkdtemp(join(this.stateDir, "feishu-staging-"));
    } catch {
      return failed("STAGED_FILE_UNREADABLE");
    }
    try {
      await copyFile(payload.stagedPath, join(cwd, basename(payload.fileName)));
    } catch {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      return failed("STAGED_FILE_UNREADABLE");
    }
    return { cwd, directory: cwd, fileName: basename(payload.fileName) };
  }

  private async sendCommand(
    args: string[],
    cwd?: string,
  ): Promise<FeishuSendResult> {
    const command = [
      "im",
      "+messages-send",
      "--chat-id",
      this.config.receiveIdType === "open_id"
        ? this.config.dmChatId
        : this.config.receiveId,
      ...args,
    ];
    try {
      const data = await this.cli.run(
        command,
        cwd === undefined ? {} : { cwd },
      );
      const id = messageIdFrom(data);
      return id === null
        ? unknown("SEND_MALFORMED_RESPONSE")
        : { status: "accepted", clientMessageId: id };
    } catch (error) {
      return sendFailureCode(error);
    }
  }

  private async handleInbound(
    event: unknown,
    callback: FeishuInboundCallback,
  ): Promise<void> {
    if (event === null || typeof event !== "object") {
      this.diagnostics.lastFilterReason = "INVALID_EVENT";
      return;
    }
    const flat = event as Record<string, unknown>;
    if (flat.type !== "im.message.receive_v1" || flat.sender_type !== "user") {
      this.diagnostics.lastFilterReason = "INVALID_EVENT";
      return;
    }
    this.diagnostics.lastEventAt = new Date().toISOString();
    if (flat.sender_id !== this.config.ownerOpenId) {
      this.diagnostics.lastFilterReason = "OWNER_MISMATCH";
      return;
    }
    if (this.config.receiveIdType === "chat_id") {
      if (
        flat.chat_type !== "group" ||
        flat.chat_id !== this.config.receiveId
      ) {
        this.diagnostics.lastFilterReason = "CHAT_MISMATCH";
        return;
      }
    } else if (
      flat.chat_type !== "p2p" ||
      flat.chat_id !== this.config.dmChatId
    ) {
      this.diagnostics.lastFilterReason = "CHAT_MISMATCH";
      return;
    }
    const id = flat.message_id;
    const type = flat.message_type;
    if (!validString(id) || !id.startsWith("om_") || !validString(type)) {
      this.diagnostics.lastFilterReason = "INVALID_MESSAGE";
      return;
    }

    if (type === "text") {
      if (typeof flat.content !== "string") {
        this.diagnostics.lastFilterReason = "INVALID_MESSAGE";
        return;
      }
      await callback({
        id,
        text: flat.content,
        receivedAt: receivedAt(flat.create_time),
        attachments: [],
      });
      return;
    }
    if (type !== "image" && type !== "file") {
      this.diagnostics.lastFilterReason = "UNSUPPORTED_MESSAGE_TYPE";
      return;
    }

    const raw = await this.cli.run([
      "api",
      "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(id)}`,
    ]);
    const body = findMessageBody(raw);
    const content = parseObject(body?.content);
    if (content === null) {
      this.diagnostics.lastFilterReason = "INVALID_MESSAGE";
      return;
    }
    const key = type === "image" ? content.image_key : content.file_key;
    if (!validString(key)) {
      this.diagnostics.lastFilterReason = "INVALID_MESSAGE";
      return;
    }
    const fileName =
      typeof content.file_name === "string" && safeFileName(content.file_name)
        ? content.file_name
        : type === "image"
          ? "image"
          : "file";
    await callback({
      id,
      text: "",
      receivedAt: receivedAt(flat.create_time),
      attachments: [{ type, key, fileName }],
    });
  }
}

function findMessageBody(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const body = object.body;
  if (body !== null && typeof body === "object")
    return body as Record<string, unknown>;
  const data = object.data;
  if (data !== null && typeof data === "object") {
    const dataObject = data as Record<string, unknown>;
    const itemBody = findMessageBody(dataObject.item);
    if (itemBody !== null) return itemBody;
    const items = dataObject.items;
    if (Array.isArray(items)) return findMessageBody(items[0]);
  }
  const itemBody = findMessageBody(object.item);
  if (itemBody !== null) return itemBody;
  const items = object.items;
  if (Array.isArray(items)) return findMessageBody(items[0]);
  return null;
}
