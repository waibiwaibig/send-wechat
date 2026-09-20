import { createHmac } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";

import {
  feishuConfigurationSchema,
  type FeishuConfiguration,
} from "../messaging/config.js";
import { nodeAgentWithSystemProxy } from "../platform/network.js";

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

type WebhookResponse = {
  statusCode: number;
  body: Buffer;
};

export type FeishuWebhookPost = (
  url: string,
  body: Buffer,
  headers: Record<string, string>,
) => Promise<WebhookResponse>;

export type FeishuClientDependencies = {
  post?: FeishuWebhookPost;
  now?: () => number;
};

const MAX_TEXT_LENGTH = 4000;
const MAX_JSON_BYTES = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

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

function isValidNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeWebhookCode(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? `FEISHU_${value}`
    : "FEISHU_REMOTE_REJECTED";
}

function safeHttpCode(statusCode: number): string {
  return Number.isInteger(statusCode) && statusCode >= 300 && statusCode <= 499
    ? `FEISHU_HTTP_${statusCode}`
    : "FEISHU_HTTP_REJECTED";
}

function validateConfiguration(
  configuration: FeishuConfiguration,
): string | null {
  return feishuConfigurationSchema.safeParse(configuration).success
    ? null
    : "INVALID_CONFIGURATION";
}

async function postWebhook(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<WebhookResponse> {
  return await new Promise<WebhookResponse>((resolve, reject) => {
    const request = (() => {
      try {
        const parsed = new URL(url);
        const options: RequestOptions = {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port === "" ? undefined : parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          method: "POST",
          headers,
          agent: nodeAgentWithSystemProxy(),
        };
        return httpsRequest(options);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("REQUEST_FAILED"));
        return null;
      }
    })();
    if (request === null) return;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error("REQUEST_TIMEOUT"));
    }, REQUEST_TIMEOUT_MS);
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    request.once("error", (error) => finish(reject, error));
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      response.on("data", (chunk: Buffer | string) => {
        if (tooLarge) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_RESPONSE_BYTES) {
          tooLarge = true;
          response.destroy(new Error("RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(buffer);
      });
      response.once("aborted", () =>
        finish(reject, new Error("RESPONSE_ABORTED")),
      );
      response.once("error", (error) => finish(reject, error));
      response.once("end", () => {
        if (tooLarge) {
          finish(reject, new Error("RESPONSE_TOO_LARGE"));
          return;
        }
        finish(resolve, {
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.end(body);
  });
}

function classifyResponse(
  response: WebhookResponse,
  clientId: string,
): FeishuSendResult {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode >= 300 && response.statusCode < 500)
      return rejected(safeHttpCode(response.statusCode));
    if (response.statusCode >= 500) return unknown("REMOTE_SERVER_ERROR");
    return unknown("NETWORK_RESULT_UNKNOWN");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString("utf8"));
  } catch {
    return unknown("MALFORMED_SEND_RESPONSE");
  }
  if (parsed === null || typeof parsed !== "object")
    return unknown("MALFORMED_SEND_RESPONSE");
  const code = (parsed as { code?: unknown }).code;
  if (code !== 0)
    return typeof code === "number"
      ? rejected(safeWebhookCode(code))
      : unknown("MALFORMED_SEND_RESPONSE");
  return { status: "accepted", clientMessageId: clientId };
}

export class FeishuClient {
  private readonly post: FeishuWebhookPost;
  private readonly now: () => number;

  public constructor(
    private readonly configuration: FeishuConfiguration,
    dependencies: FeishuClientDependencies = {},
  ) {
    this.post = dependencies.post ?? postWebhook;
    this.now = dependencies.now ?? Date.now;
  }

  public async send(
    payload: FeishuPayload,
    clientId: string,
  ): Promise<FeishuSendResult> {
    if (payload.type !== "text") return rejected("FEISHU_TEXT_ONLY");
    const configurationError = validateConfiguration(this.configuration);
    if (configurationError !== null) return failed(configurationError);
    if (!isValidNonEmptyString(clientId)) return rejected("INVALID_CLIENT_ID");
    if (payload.text.length === 0) return rejected("EMPTY_TEXT");
    if (Array.from(payload.text).length > MAX_TEXT_LENGTH)
      return rejected("TEXT_TOO_LONG");

    const content: {
      msg_type: "text";
      content: { text: string };
      timestamp?: string;
      sign?: string;
    } = {
      msg_type: "text",
      content: { text: payload.text },
    };
    if (this.configuration.signingSecret !== undefined) {
      const timestamp = Math.floor(this.now() / 1000).toString();
      content.timestamp = timestamp;
      content.sign = createHmac(
        "sha256",
        `${timestamp}\n${this.configuration.signingSecret}`,
      )
        .update("")
        .digest("base64");
    }
    const body = Buffer.from(JSON.stringify(content), "utf8");
    if (body.length > MAX_JSON_BYTES) return rejected("JSON_TOO_LARGE");

    try {
      const response = await this.post(this.configuration.webhookUrl, body, {
        "content-type": "application/json",
        "content-length": body.length.toString(),
      });
      return classifyResponse(response, clientId);
    } catch (error) {
      return unknown(
        error instanceof Error && error.message === "REQUEST_TIMEOUT"
          ? "NETWORK_TIMEOUT"
          : "NETWORK_RESULT_UNKNOWN",
      );
    }
  }

  public async verify(): Promise<void> {
    if (validateConfiguration(this.configuration) !== null)
      throw codedError("FEISHU_CONFIGURATION_INVALID");
    await Promise.resolve();
  }
}
