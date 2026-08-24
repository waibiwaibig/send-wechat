import { z } from "zod";

import { RelayProtocolError } from "./protocol.js";

const BASE64URL = /^[A-Za-z0-9_-]{1,11184811}$/;
const forwardedRequestSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("request"),
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  payload: z.string().regex(BASE64URL),
});

export type RelayForwardedRequest = z.infer<typeof forwardedRequestSchema>;

export class HubRelayConnectionError extends Error {
  public readonly code = "RELAY_FORWARD_INVALID";

  public constructor() {
    super("RELAY_FORWARD_INVALID");
    this.name = "HubRelayConnectionError";
  }
}

export class HubRelayConnection {
  public constructor(
    private readonly processor: { process(frame: Buffer): Promise<Buffer> },
  ) {}

  public async respond(message: string): Promise<string> {
    let raw: unknown;
    try {
      raw = JSON.parse(message) as unknown;
    } catch {
      throw new HubRelayConnectionError();
    }
    const parsed = forwardedRequestSchema.safeParse(raw);
    if (!parsed.success) throw new HubRelayConnectionError();
    let requestFrame: Buffer;
    try {
      requestFrame = decodeBase64Url(parsed.data.payload);
    } catch {
      throw new HubRelayConnectionError();
    }
    try {
      const response = await this.processor.process(requestFrame);
      if (response.byteLength === 0 || response.byteLength > 8 * 1024 * 1024)
        throw new RelayProtocolError("RELAY_RESPONSE_INVALID");
      return JSON.stringify({
        v: 1,
        type: "response",
        requestId: parsed.data.requestId,
        payload: response.toString("base64url"),
      });
    } catch (error) {
      const code =
        error instanceof RelayProtocolError &&
        /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
          ? error.code
          : "RELAY_PROCESSING_FAILED";
      const retryable =
        error instanceof RelayProtocolError && error.retryable === true;
      return JSON.stringify({
        v: 1,
        type: "error",
        requestId: parsed.data.requestId,
        error: { code, retryable },
      });
    }
  }
}

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > 8 * 1024 * 1024 ||
    decoded.toString("base64url") !== value
  )
    throw new HubRelayConnectionError();
  return decoded;
}
