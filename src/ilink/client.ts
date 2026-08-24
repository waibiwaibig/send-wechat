import {
  createCipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { fileTypeFromFile } from "file-type";
import { z } from "zod";

import {
  fetchWithSystemProxy,
  type PlatformFetch,
} from "../platform/network.js";
import type { IlinkPort, IlinkSendRequest } from "../runtime/ports.js";

export const ILINK_PROTOCOL_VERSION = "2.4.6" as const;
export const ILINK_PROTOCOL_COMMIT =
  "cef0bfc390393f716903e16d50408118047f87e0" as const;
export const ILINK_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com" as const;
export const ILINK_CDN_BASE_URL =
  "https://novac2c.cdn.weixin.qq.com/c2c" as const;

const ILINK_APP_ID = "bot";
const ILINK_BOT_TYPE = "3";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const CDN_UPLOAD_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const CDN_UPLOAD_ATTEMPTS = 3;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

type PreparedMedia = {
  stagedPath: string;
  encryptedPath: string;
  fileKey: string;
  aesKey: Buffer;
  mediaType: 1 | 2 | 3;
  plaintextSize: number;
  encryptedSize: number;
  plaintextMd5: string;
};

export type IlinkClientDependencies = {
  fetch?: PlatformFetch;
  randomBytes?: (size: number) => Buffer;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  productVersion: string;
};

export type PollUpdatesResult =
  | {
      status: "ok";
      cursor: string;
      suggestedTimeoutMs: number;
      inbound: Array<{
        messageType: number;
        fromUserId: string;
        contextToken: string | null;
        createTimeMs: number | null;
      }>;
    }
  | { status: "auth_stale" }
  | { status: "retry"; code: string };

export type QrStatus =
  | {
      status:
        | "wait"
        | "scaned"
        | "expired"
        | "verify_code_blocked"
        | "binded_redirect";
    }
  | { status: "need_verifycode" }
  | { status: "scaned_but_redirect"; redirectHost: string | null }
  | {
      status: "confirmed";
      botToken: string;
      botId: string;
      userId: string;
      baseUrl: string;
    };

export class IlinkProtocolError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "IlinkProtocolError";
  }
}

const sendResponseSchema = z.object({
  ret: z.number().int(),
  errmsg: z.string().optional(),
});

const uploadUrlResponseSchema = z.object({
  ret: z.number().int().optional().default(0),
  upload_full_url: z
    .string()
    .max(16 * 1024)
    .optional(),
  upload_param: z
    .string()
    .max(16 * 1024)
    .optional(),
});

const updatesResponseSchema = z.object({
  ret: z.number().int().optional().default(0),
  errcode: z.number().int().optional().default(0),
  get_updates_buf: z
    .string()
    .max(1024 * 1024)
    .optional()
    .default(""),
  longpolling_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .default(35_000),
  msgs: z
    .array(
      z.object({
        message_type: z.number().int().optional().default(0),
        from_user_id: z.string().max(4096).optional().default(""),
        context_token: z
          .string()
          .max(64 * 1024)
          .optional(),
        create_time_ms: z.number().int().optional(),
      }),
    )
    .max(1000)
    .optional()
    .default([]),
});

const qrResponseSchema = z.object({
  qrcode: z.string().min(1).max(4096),
  qrcode_img_content: z
    .string()
    .min(1)
    .max(16 * 1024),
});

const qrStatusSchema = z.object({
  status: z.string(),
  bot_token: z
    .string()
    .max(64 * 1024)
    .optional(),
  ilink_bot_id: z.string().max(4096).optional(),
  ilink_user_id: z.string().max(4096).optional(),
  baseurl: z.string().max(4096).optional(),
  redirect_host: z.string().max(253).optional(),
});

export class IlinkClient implements IlinkPort {
  private readonly fetch: PlatformFetch;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private lastSendMessageAt: number | null = null;
  private pacingTail: Promise<void> = Promise.resolve();
  private longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;

  public constructor(private readonly dependencies: IlinkClientDependencies) {
    this.fetch = dependencies.fetch ?? fetchWithSystemProxy;
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = dependencies.now ?? Date.now;
  }

  public async send(request: IlinkSendRequest): ReturnType<IlinkPort["send"]> {
    if (request.secret.contextToken === null) {
      return { status: "failed", code: "INVALID_SEND_INPUT" };
    }

    if (request.payload.type === "file") {
      return this.sendFile(request);
    }

    return this.sendMessageBody(request, [
      { type: 1, text_item: { text: request.payload.text } },
    ]);
  }

  private async sendMessageBody(
    request: IlinkSendRequest,
    itemList: unknown[],
  ): ReturnType<IlinkPort["send"]> {
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: request.binding.userId,
        client_id: request.clientId,
        message_type: 2,
        message_state: 2,
        item_list: itemList,
        context_token: request.secret.contextToken,
      },
      base_info: this.baseInfo(),
    };

    try {
      await this.paceSendMessage();
      const raw = await this.postJson({
        baseUrl: request.binding.baseUrl,
        endpoint: "ilink/bot/sendmessage",
        token: request.secret.botToken,
        body,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      });
      const parsed = sendResponseSchema.safeParse(raw);
      if (!parsed.success)
        return { status: "unknown", code: "MALFORMED_SEND_RESPONSE" };
      if (parsed.data.ret !== 0) {
        return { status: "rejected", code: `ILINK_RET_${parsed.data.ret}` };
      }
      return { status: "accepted", clientMessageId: request.clientId };
    } catch {
      return { status: "unknown", code: "NETWORK_RESULT_UNKNOWN" };
    }
  }

  private paceSendMessage(): Promise<void> {
    const pacing = this.pacingTail.then(async () => {
      const current = this.now();
      if (this.lastSendMessageAt !== null) {
        const remaining = this.lastSendMessageAt + 2000 - current;
        if (remaining > 0) await this.sleep(remaining);
      }
      this.lastSendMessageAt = Math.max(
        this.now(),
        (this.lastSendMessageAt ?? -2000) + 2000,
      );
    });
    this.pacingTail = pacing.catch(() => undefined);
    return pacing;
  }

  private async sendFile(
    request: IlinkSendRequest,
  ): ReturnType<IlinkPort["send"]> {
    if (request.payload.type !== "file") {
      return { status: "failed", code: "INVALID_SEND_INPUT" };
    }
    if (
      request.payload.fileName !==
        request.payload.fileName.split(/[\\/]/).at(-1) ||
      /[\u0000-\u001f\u007f]/.test(request.payload.fileName) ||
      Buffer.byteLength(request.payload.fileName, "utf8") > 255
    ) {
      return { status: "failed", code: "INVALID_FILE_NAME" };
    }

    let prepared: PreparedMedia | null = null;
    try {
      prepared = await this.prepareMedia(
        request.payload.stagedPath,
        request.payload.byteLength,
      );
      const upload = await this.requestUpload(request, prepared);
      if (upload.status !== "ok") return upload;
      const uploaded = await this.uploadEncrypted(prepared, upload.url);
      if (uploaded.status !== "ok") return uploaded;

      const media = {
        encrypt_query_param: uploaded.downloadParameter,
        aes_key: prepared.aesKey.toString("base64"),
        encrypt_type: 1,
      };
      const item =
        prepared.mediaType === 1
          ? { type: 2, image_item: { media, mid_size: prepared.encryptedSize } }
          : prepared.mediaType === 2
            ? {
                type: 5,
                video_item: { media, video_size: prepared.encryptedSize },
              }
            : {
                type: 4,
                file_item: {
                  media,
                  file_name: request.payload.fileName,
                  len: String(prepared.plaintextSize),
                },
              };
      return await this.sendMessageBody(request, [item]);
    } catch (error) {
      if (error instanceof IlinkProtocolError) {
        return { status: "failed", code: error.code };
      }
      return { status: "failed", code: "MEDIA_PREPARATION_FAILED" };
    } finally {
      if (prepared !== null) {
        await rm(prepared.encryptedPath, { force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  private async prepareMedia(
    stagedPath: string,
    expectedSize: number,
  ): Promise<PreparedMedia> {
    const metadata = await lstat(stagedPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new IlinkProtocolError("INVALID_STAGED_FILE");
    }
    if (
      metadata.size !== expectedSize ||
      metadata.size <= 0 ||
      metadata.size > MAX_FILE_BYTES
    ) {
      throw new IlinkProtocolError("INVALID_FILE_SIZE");
    }

    const detected = await fileTypeFromFile(stagedPath).catch(() => undefined);
    const mediaType = detected?.mime.startsWith("image/")
      ? 1
      : detected?.mime.startsWith("video/")
        ? 2
        : 3;
    const fileKey = this.randomBytes(16).toString("hex");
    const aesKey = this.randomBytes(16);
    const encryptedPath = join(
      dirname(stagedPath),
      `.send-wechat-${randomUUID()}.encrypted`,
    );
    const hash = createHash("md5");
    const hashTap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const cipher = createCipheriv("aes-128-ecb", aesKey, null);
    try {
      await pipeline(
        createReadStream(stagedPath),
        hashTap,
        cipher,
        createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      await rm(encryptedPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      stagedPath,
      encryptedPath,
      fileKey,
      aesKey,
      mediaType,
      plaintextSize: metadata.size,
      encryptedSize: aesEcbPaddedSize(metadata.size),
      plaintextMd5: hash.digest("hex"),
    };
  }

  private async requestUpload(
    request: IlinkSendRequest,
    prepared: PreparedMedia,
  ): Promise<{ status: "ok"; url: URL } | { status: "failed"; code: string }> {
    let raw: unknown;
    try {
      raw = await this.postJson({
        baseUrl: request.binding.baseUrl,
        endpoint: "ilink/bot/getuploadurl",
        token: request.secret.botToken,
        body: {
          filekey: prepared.fileKey,
          media_type: prepared.mediaType,
          to_user_id: request.binding.userId,
          rawsize: prepared.plaintextSize,
          rawfilemd5: prepared.plaintextMd5,
          filesize: prepared.encryptedSize,
          no_need_thumb: true,
          aeskey: prepared.aesKey.toString("hex"),
          base_info: this.baseInfo(),
        },
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      });
    } catch {
      return { status: "failed", code: "UPLOAD_URL_UNAVAILABLE" };
    }
    const parsed = uploadUrlResponseSchema.safeParse(raw);
    if (!parsed.success)
      return { status: "failed", code: "MALFORMED_UPLOAD_RESPONSE" };
    if (parsed.data.ret !== 0) {
      return { status: "failed", code: `ILINK_RET_${parsed.data.ret}` };
    }
    const fullUrl = parsed.data.upload_full_url?.trim();
    const fallback = parsed.data.upload_param?.trim();
    if (fullUrl === undefined && fallback === undefined) {
      return { status: "failed", code: "UPLOAD_URL_MISSING" };
    }
    const value =
      fullUrl ??
      `${ILINK_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(fallback ?? "")}&filekey=${encodeURIComponent(prepared.fileKey)}`;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { status: "failed", code: "UPLOAD_URL_INVALID" };
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return { status: "failed", code: "UPLOAD_URL_INVALID" };
    }
    return { status: "ok", url };
  }

  private async uploadEncrypted(
    prepared: PreparedMedia,
    url: URL,
  ): Promise<
    | { status: "ok"; downloadParameter: string }
    | { status: "failed"; code: string }
  > {
    for (let attempt = 1; attempt <= CDN_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        const body = Readable.toWeb(createReadStream(prepared.encryptedPath));
        const response = await this.fetch(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(CDN_UPLOAD_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(prepared.encryptedSize),
          },
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        if (response.status >= 400 && response.status < 500) {
          await response.body?.cancel().catch(() => undefined);
          return { status: "failed", code: "CDN_UPLOAD_4XX" };
        }
        if (response.status === 200) {
          const downloadParameter = response.headers.get("x-encrypted-param");
          await response.body?.cancel().catch(() => undefined);
          if (
            downloadParameter !== null &&
            downloadParameter !== "" &&
            downloadParameter.length <= 16 * 1024
          ) {
            return { status: "ok", downloadParameter };
          }
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
      } catch {
        // Retried below. No sendmessage request has begun at this point.
      }
      if (attempt < CDN_UPLOAD_ATTEMPTS) await this.sleep(250 * attempt);
    }
    return { status: "failed", code: "CDN_UPLOAD_FAILED" };
  }

  public async pollUpdates(params: {
    baseUrl: string;
    botToken: string;
    cursor: string;
    signal?: AbortSignal;
  }): Promise<PollUpdatesResult> {
    let raw: unknown;
    try {
      raw = await this.postJson({
        baseUrl: params.baseUrl,
        endpoint: "ilink/bot/getupdates",
        token: params.botToken,
        body: {
          get_updates_buf: params.cursor,
          base_info: this.baseInfo(),
        },
        timeoutMs: this.longPollTimeoutMs,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
      });
    } catch (error) {
      if (params.signal?.aborted) return { status: "retry", code: "ABORTED" };
      if (isTimeoutError(error)) {
        return {
          status: "ok",
          cursor: params.cursor,
          suggestedTimeoutMs: this.longPollTimeoutMs,
          inbound: [],
        };
      }
      return { status: "retry", code: "NETWORK_FAILURE" };
    }

    const parsed = updatesResponseSchema.safeParse(raw);
    if (!parsed.success)
      return { status: "retry", code: "MALFORMED_UPDATES_RESPONSE" };
    if (parsed.data.errcode === -14 || parsed.data.ret === -14)
      return { status: "auth_stale" };
    if (parsed.data.ret !== 0)
      return { status: "retry", code: `ILINK_RET_${parsed.data.ret}` };
    if (parsed.data.errcode !== 0)
      return { status: "retry", code: `ILINK_ERR_${parsed.data.errcode}` };

    this.longPollTimeoutMs = Math.min(
      60_000,
      Math.max(5_000, parsed.data.longpolling_timeout_ms),
    );
    return {
      status: "ok",
      cursor:
        parsed.data.get_updates_buf === ""
          ? params.cursor
          : parsed.data.get_updates_buf,
      suggestedTimeoutMs: this.longPollTimeoutMs,
      inbound: parsed.data.msgs.map((message) => ({
        messageType: message.message_type,
        fromUserId: message.from_user_id,
        contextToken: message.context_token ?? null,
        createTimeMs: message.create_time_ms ?? null,
      })),
    };
  }

  public async createQr(localBotTokens: readonly string[]): Promise<{
    qrcode: string;
    qrContent: string;
  }> {
    const raw = await this.postJson({
      baseUrl: ILINK_LOGIN_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`,
      body: { local_token_list: [...localBotTokens].slice(0, 10) },
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const parsed = qrResponseSchema.safeParse(raw);
    if (!parsed.success) throw new IlinkProtocolError("MALFORMED_QR_RESPONSE");
    return {
      qrcode: parsed.data.qrcode,
      qrContent: parsed.data.qrcode_img_content,
    };
  }

  public async pollQr(params: {
    qrcode: string;
    baseUrl: string;
    verifyCode?: string;
    signal?: AbortSignal;
  }): Promise<QrStatus> {
    const endpoint = new URL(
      "ilink/bot/get_qrcode_status",
      this.validateBaseUrl(params.baseUrl),
    );
    endpoint.searchParams.set("qrcode", params.qrcode);
    if (params.verifyCode !== undefined)
      endpoint.searchParams.set("verify_code", params.verifyCode);

    const raw = await this.getJson({
      url: endpoint,
      timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    const parsed = qrStatusSchema.safeParse(raw);
    if (!parsed.success) throw new IlinkProtocolError("MALFORMED_QR_STATUS");
    const data = parsed.data;
    switch (data.status) {
      case "wait":
      case "scaned":
      case "expired":
      case "verify_code_blocked":
      case "binded_redirect":
        return { status: data.status };
      case "need_verifycode":
        return { status: "need_verifycode" };
      case "scaned_but_redirect":
        return {
          status: "scaned_but_redirect",
          redirectHost: data.redirect_host ?? null,
        };
      case "confirmed": {
        if (
          data.bot_token === undefined ||
          data.ilink_bot_id === undefined ||
          data.ilink_user_id === undefined ||
          data.baseurl === undefined
        ) {
          throw new IlinkProtocolError("INCOMPLETE_QR_CONFIRMATION");
        }
        return {
          status: "confirmed",
          botToken: data.bot_token,
          botId: data.ilink_bot_id,
          userId: data.ilink_user_id,
          baseUrl: this.validateBaseUrl(data.baseurl)
            .toString()
            .replace(/\/$/, ""),
        };
      }
      default:
        throw new IlinkProtocolError("UNKNOWN_QR_STATE");
    }
  }

  public async notifyLifecycle(params: {
    type: "start" | "stop";
    baseUrl: string;
    botToken: string;
  }): Promise<void> {
    try {
      await this.postJson({
        baseUrl: params.baseUrl,
        endpoint: `ilink/bot/msg/notify${params.type}`,
        token: params.botToken,
        body: { base_info: this.baseInfo() },
        timeoutMs: 10_000,
      });
    } catch {
      await this.sleep(0);
    }
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return {
      channel_version: ILINK_PROTOCOL_VERSION,
      bot_agent: `send-wechat/${this.dependencies.productVersion}`,
    };
  }

  private commonHeaders(): Headers {
    return new Headers({
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(
        buildClientVersion(ILINK_PROTOCOL_VERSION),
      ),
    });
  }

  private postHeaders(token?: string): Headers {
    const headers = this.commonHeaders();
    headers.set("Content-Type", "application/json");
    headers.set("AuthorizationType", "ilink_bot_token");
    headers.set(
      "X-WECHAT-UIN",
      Buffer.from(String(this.randomBytes(4).readUInt32BE(0)), "utf8").toString(
        "base64",
      ),
    );
    if (token !== undefined) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return headers;
  }

  private async postJson(params: {
    baseUrl: string;
    endpoint: string;
    body: unknown;
    token?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const url = new URL(params.endpoint, this.validateBaseUrl(params.baseUrl));
    return this.fetchJson(url, {
      method: "POST",
      headers: this.postHeaders(params.token),
      body: JSON.stringify(params.body),
      timeoutMs: params.timeoutMs,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
  }

  private async getJson(params: {
    url: URL;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    return this.fetchJson(params.url, {
      method: "GET",
      headers: this.commonHeaders(),
      timeoutMs: params.timeoutMs,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
  }

  private async fetchJson(
    url: URL,
    params: {
      method: "GET" | "POST";
      headers: Headers;
      body?: string;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(params.timeoutMs);
    const signal =
      params.signal === undefined
        ? timeout
        : AbortSignal.any([timeout, params.signal]);
    const response = await this.fetch(url, {
      method: params.method,
      redirect: "error",
      headers: params.headers,
      ...(params.body === undefined ? {} : { body: params.body }),
      signal,
    });
    if (!response.ok) throw new IlinkProtocolError(`HTTP_${response.status}`);
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MAX_JSON_RESPONSE_BYTES)
    ) {
      throw new IlinkProtocolError("RESPONSE_TOO_LARGE");
    }
    if (response.body === null) throw new IlinkProtocolError("EMPTY_RESPONSE");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new IlinkProtocolError("RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      return JSON.parse(
        Buffer.concat(chunks, total).toString("utf8"),
      ) as unknown;
    } catch {
      throw new IlinkProtocolError("MALFORMED_JSON_RESPONSE");
    }
  }

  private validateBaseUrl(value: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(value.endsWith("/") ? value : `${value}/`);
    } catch {
      throw new IlinkProtocolError("INVALID_BASE_URL");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new IlinkProtocolError("INVALID_BASE_URL");
    }
    return parsed;
  }
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      (error.name === "AbortError" &&
        /tim(?:e|ed)[ -]?out/i.test(error.message)))
  );
}
