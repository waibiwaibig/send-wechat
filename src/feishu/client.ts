import type { Agent as HttpAgent } from "node:http";
import { nodeAgentWithSystemProxy } from "../platform/network.js";
import { fileTypeFromFile } from "file-type";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import * as lark from "@larksuiteoapi/node-sdk";

export type FeishuCredentials = {
  appId: string;
  appSecret: string;
};

export type FeishuTarget = {
  receiveIdType: "open_id" | "chat_id";
  receiveId: string;
  ownerOpenId: string;
};

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

type ApiResponse = {
  code?: unknown;
  msg?: unknown;
  data?: {
    message_id?: unknown;
    image_key?: unknown;
    file_key?: unknown;
  };
  message_id?: unknown;
  image_key?: unknown;
  file_key?: unknown;
};

type VerifyResponse = ApiResponse;

type FeishuLogger = {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
};

type FeishuHttpInstance = typeof lark.defaultHttpInstance;

type FeishuApiClient = {
  request(payload: {
    method: "GET";
    url: string;
  }): Promise<VerifyResponse | null>;
  im: {
    image: {
      create(payload: {
        data: { image_type: "message"; image: Buffer | Readable };
      }): Promise<ApiResponse | null>;
    };
    file: {
      create(payload: {
        data: {
          file_type: "stream";
          file_name: string;
          file: Buffer | Readable;
        };
      }): Promise<ApiResponse | null>;
    };
    message: {
      create(payload: {
        params: { receive_id_type: "open_id" | "chat_id" };
        data: {
          receive_id: string;
          msg_type: "text" | "image" | "file";
          content: string;
          uuid: string;
        };
      }): Promise<ApiResponse | null>;
    };
    messageResource: {
      get(payload: {
        params: { type: string };
        path: { message_id: string; file_key: string };
      }): Promise<{
        getReadableStream(): Readable;
      }>;
    };
  };
};

type FeishuEventDispatcher = {
  register(
    handles: Record<string, (event: unknown) => unknown>,
  ): FeishuEventDispatcher;
};

type FeishuWsClient = {
  start(params: { eventDispatcher: FeishuEventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
};

export type FeishuSdkFactory = {
  Client: new (params: {
    appId: string;
    appSecret: string;
    logger?: FeishuLogger;
    httpInstance?: FeishuHttpInstance;
  }) => FeishuApiClient;
  EventDispatcher: new (
    params?: Record<string, unknown>,
  ) => FeishuEventDispatcher;
  WSClient: new (params: {
    appId: string;
    appSecret: string;
    autoReconnect?: boolean;
    agent?: HttpAgent;
    logger?: FeishuLogger;
    httpInstance?: FeishuHttpInstance;
  }) => FeishuWsClient;
};

const silentLogger: FeishuLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

const defaultSdk: FeishuSdkFactory = {
  Client: lark.Client as unknown as FeishuSdkFactory["Client"],
  EventDispatcher:
    lark.EventDispatcher as unknown as FeishuSdkFactory["EventDispatcher"],
  WSClient: lark.WSClient as unknown as FeishuSdkFactory["WSClient"],
};

const MAX_TEXT_LENGTH = 4000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;
const API_TIMEOUT_MS = 10_000;

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

function responseCode(response: ApiResponse | null): number | null {
  return typeof response?.code === "number" && Number.isInteger(response.code)
    ? response.code
    : null;
}

function safeApiCode(response: ApiResponse | null): string | null {
  const code = responseCode(response);
  if (code === null || code === 0) return null;
  return `FEISHU_${code}`;
}

function safeThrownApiCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code)
    ? `FEISHU_${code}`
    : null;
}

function codedError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function isValidNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseContent(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function receivedAt(createTime: string | undefined): number {
  const milliseconds = createTime === undefined ? NaN : Number(createTime);
  return Number.isFinite(milliseconds) ? milliseconds : Date.now();
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
    this.total += Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(chunk, encoding);
    if (this.total > this.limit) {
      callback(new Error("RESOURCE_TOO_LARGE"));
      return;
    }
    callback(
      null,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
    );
  }
}

export class FeishuClient {
  private readonly sdk: FeishuSdkFactory;
  private readonly api: FeishuApiClient;
  private wsClient: FeishuWsClient | null = null;

  public constructor(
    private readonly credentials: FeishuCredentials,
    private readonly target: FeishuTarget,
    sdk: FeishuSdkFactory = defaultSdk,
  ) {
    this.sdk = sdk;
    if (sdk === defaultSdk) {
      lark.defaultHttpInstance.defaults.timeout = API_TIMEOUT_MS;
      lark.defaultHttpInstance.defaults.maxRedirects = 0;
      lark.defaultHttpInstance.defaults.proxy = false;
      lark.defaultHttpInstance.defaults.httpAgent = nodeAgentWithSystemProxy();
      lark.defaultHttpInstance.defaults.httpsAgent = nodeAgentWithSystemProxy();
    }
    const clientParams: {
      appId: string;
      appSecret: string;
      logger: FeishuLogger;
      httpInstance?: FeishuHttpInstance;
    } = {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      logger: silentLogger,
    };
    if (sdk === defaultSdk)
      clientParams.httpInstance = lark.defaultHttpInstance;
    this.api = new sdk.Client(clientParams);
  }

  public async send(
    payload: FeishuPayload,
    clientId: string,
  ): Promise<FeishuSendResult> {
    const targetError = this.validateTarget();
    if (targetError !== null) return targetError;
    if (!isValidNonEmptyString(clientId)) return rejected("INVALID_CLIENT_ID");

    if (payload.type === "text") {
      if (payload.text.length === 0) return rejected("EMPTY_TEXT");
      if (Array.from(payload.text).length > MAX_TEXT_LENGTH)
        return rejected("TEXT_TOO_LONG");
      return this.sendMessage(
        "text",
        JSON.stringify({ text: payload.text }),
        clientId,
      );
    }

    const prepared = await this.prepareUpload(payload);
    if ("status" in prepared) return prepared;
    const contentKey = prepared.key;
    const content =
      payload.type === "image"
        ? JSON.stringify({ image_key: contentKey })
        : JSON.stringify({ file_key: contentKey });
    return this.sendMessage(payload.type, content, clientId);
  }

  /** Verify credentials against Feishu's bot identity endpoint without sending a message. */
  public async verify(): Promise<void> {
    const targetError = this.validateTarget();
    if (targetError !== null) {
      throw codedError(
        "code" in targetError ? targetError.code : "INVALID_TARGET",
      );
    }
    let response: VerifyResponse | null;
    try {
      response = await this.api.request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
    } catch (error) {
      const apiError = safeThrownApiCode(error);
      throw codedError(apiError ?? "VERIFY_NETWORK_ERROR");
    }
    const apiResponse = response;
    const apiError = safeApiCode(apiResponse);
    if (apiError !== null) throw codedError(apiError);
    if (responseCode(apiResponse) !== 0)
      throw codedError("MALFORMED_VERIFY_RESPONSE");
  }

  public async startReceiving(callback: FeishuInboundCallback): Promise<void> {
    if (this.wsClient !== null) return;

    const dispatcher = new this.sdk.EventDispatcher({ logger: silentLogger });
    dispatcher.register({
      "im.message.receive_v1": async (event: unknown) => {
        await this.handleInbound(event, callback);
      },
    });
    const wsParams: {
      appId: string;
      appSecret: string;
      autoReconnect: boolean;
      agent?: HttpAgent;
      logger: FeishuLogger;
      httpInstance?: FeishuHttpInstance;
    } = {
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
      autoReconnect: true,
      logger: silentLogger,
    };
    if (this.sdk === defaultSdk) {
      wsParams.httpInstance = lark.defaultHttpInstance;
      wsParams.agent = nodeAgentWithSystemProxy();
    }
    const wsClient = new this.sdk.WSClient(wsParams);
    this.wsClient = wsClient;
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
    } catch (error) {
      this.wsClient = null;
      throw error;
    }
  }

  public close(): void {
    const wsClient = this.wsClient;
    this.wsClient = null;
    if (wsClient !== null) wsClient.close({ force: true });
  }

  public async downloadResource(
    messageId: string,
    key: string,
    type: "image" | "file",
    destination: string,
  ): Promise<void> {
    if (!isValidNonEmptyString(messageId))
      throw new Error("INVALID_MESSAGE_ID");
    if (!isValidNonEmptyString(key)) throw new Error("INVALID_RESOURCE_KEY");
    if (!isValidNonEmptyString(destination))
      throw new Error("INVALID_DESTINATION");

    const resource = await this.api.im.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: key },
    });
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
        resource.getReadableStream(),
        new ByteLimitTransform(MAX_RESOURCE_BYTES),
        output,
      );
    } catch (error) {
      if (created) await rm(destination, { force: true });
      throw error;
    }
  }

  private validateTarget(): FeishuSendResult | null {
    if (
      !isValidNonEmptyString(this.credentials.appId) ||
      !isValidNonEmptyString(this.credentials.appSecret)
    ) {
      return failed("INVALID_CREDENTIALS");
    }
    if (
      !isValidNonEmptyString(this.target.receiveId) ||
      !isValidNonEmptyString(this.target.ownerOpenId)
    ) {
      return failed("INVALID_TARGET");
    }
    return null;
  }

  private async prepareUpload(
    payload: Extract<FeishuPayload, { type: "image" | "file" }>,
  ): Promise<{ key: string } | FeishuSendResult> {
    const limit = payload.type === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (
      !isValidNonEmptyString(payload.stagedPath) ||
      !isValidNonEmptyString(payload.fileName)
    ) {
      return rejected("INVALID_MEDIA");
    }
    if (!Number.isSafeInteger(payload.byteLength) || payload.byteLength <= 0) {
      return rejected("INVALID_MEDIA_SIZE");
    }
    if (payload.byteLength > limit) {
      return rejected(
        payload.type === "image" ? "IMAGE_TOO_LARGE" : "FILE_TOO_LARGE",
      );
    }

    let fileSize: number;
    try {
      const staged = await lstat(payload.stagedPath);
      if (!staged.isFile()) return failed("STAGED_FILE_UNREADABLE");
      fileSize = staged.size;
    } catch {
      return failed("STAGED_FILE_UNREADABLE");
    }
    if (fileSize !== payload.byteLength) return rejected("MEDIA_SIZE_MISMATCH");
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

    const file = createReadStream(payload.stagedPath);
    try {
      const response =
        payload.type === "image"
          ? await this.api.im.image.create({
              data: { image_type: "message", image: file },
            })
          : await this.api.im.file.create({
              data: { file_type: "stream", file_name: payload.fileName, file },
            });
      const apiError = safeApiCode(response);
      if (apiError !== null) return rejected(apiError);
      const key =
        payload.type === "image" ? response?.image_key : response?.file_key;
      return isValidNonEmptyString(key)
        ? { key }
        : failed("MALFORMED_UPLOAD_RESPONSE");
    } catch (error) {
      const apiError = safeThrownApiCode(error);
      if (apiError !== null) return rejected(apiError);
      return failed("UPLOAD_FAILED");
    } finally {
      file.destroy();
    }
  }

  private async sendMessage(
    type: "text" | "image" | "file",
    content: string,
    clientId: string,
  ): Promise<FeishuSendResult> {
    try {
      const response = await this.api.im.message.create({
        params: { receive_id_type: this.target.receiveIdType },
        data: {
          receive_id: this.target.receiveId,
          msg_type: type,
          content,
          uuid: clientId,
        },
      });
      const apiError = safeApiCode(response);
      if (apiError !== null) return rejected(apiError);
      if (responseCode(response) !== 0)
        return unknown("MALFORMED_SEND_RESPONSE");
      const messageId = response?.data?.message_id;
      return isValidNonEmptyString(messageId)
        ? { status: "accepted", clientMessageId: messageId }
        : unknown("MALFORMED_SEND_RESPONSE");
    } catch (error) {
      const apiError = safeThrownApiCode(error);
      if (apiError !== null) return rejected(apiError);
      return unknown("NETWORK_RESULT_UNKNOWN");
    }
  }

  private async handleInbound(
    event: unknown,
    callback: FeishuInboundCallback,
  ): Promise<void> {
    if (event === null || typeof event !== "object") return;
    const candidate = event as {
      sender?: { sender_id?: { open_id?: string } };
      message?: {
        message_id?: string;
        chat_id?: string;
        chat_type?: string;
        message_type?: string;
        content?: string;
        create_time?: string;
      };
    };
    const senderId = candidate.sender?.sender_id?.open_id;
    const message = candidate.message;
    if (
      !isValidNonEmptyString(senderId) ||
      senderId !== this.target.ownerOpenId ||
      message === undefined
    )
      return;
    if (this.target.receiveIdType === "chat_id") {
      if (
        message.chat_type !== "group" ||
        message.chat_id !== this.target.receiveId
      )
        return;
    } else if (message.chat_type !== "p2p") {
      return;
    }
    if (
      !isValidNonEmptyString(message.message_id) ||
      !isValidNonEmptyString(message.content)
    )
      return;

    const content = parseContent(message.content);
    if (content === null) return;
    const attachments: FeishuInboundAttachment[] = [];
    let text = "";
    if (message.message_type === "text" && typeof content.text === "string") {
      text = content.text;
    } else if (
      message.message_type === "image" &&
      isValidNonEmptyString(content.image_key)
    ) {
      attachments.push({
        type: "image",
        key: content.image_key,
        fileName: "image",
      });
    } else if (
      message.message_type === "file" &&
      isValidNonEmptyString(content.file_key)
    ) {
      attachments.push({
        type: "file",
        key: content.file_key,
        fileName:
          typeof content.file_name === "string"
            ? content.file_name
                .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
                .slice(0, 120) || "file"
            : "file",
      });
    } else {
      return;
    }
    await callback({
      id: message.message_id,
      text,
      receivedAt: receivedAt(message.create_time),
      attachments,
    });
  }
}
