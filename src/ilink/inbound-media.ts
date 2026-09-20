import { createDecipheriv } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { PlatformFetch } from "../platform/network.js";

export const INBOUND_MEDIA_CDN_BASE_URL =
  "https://novac2c.cdn.weixin.qq.com/c2c" as const;
export const MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024;

export type InboundAttachmentDescriptor = {
  type: "image" | "file";
  fileName: string;
  encryptQueryParam: string | null;
  aesKey: string | null;
  fullUrl: string | null;
  imageAesKeyHex: string | null;
};

export class InboundMediaError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "InboundMediaError";
  }
}

export async function downloadInboundAttachment(
  descriptor: InboundAttachmentDescriptor,
  destination: string,
  dependencies: { fetch: PlatformFetch },
): Promise<void> {
  const key = parseAesKey(descriptor);
  const url = resolveDownloadUrl(descriptor);
  let response: Response;
  try {
    response = await dependencies.fetch(url, { redirect: "error" });
  } catch (error) {
    if (error instanceof InboundMediaError) throw error;
    throw new InboundMediaError("INBOUND_MEDIA_DOWNLOAD_FAILED");
  }
  if (!response.ok)
    throw new InboundMediaError(`INBOUND_MEDIA_HTTP_${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > MAX_INBOUND_MEDIA_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new InboundMediaError("INBOUND_MEDIA_RESPONSE_TOO_LARGE");
  }
  if (response.body === null)
    throw new InboundMediaError("INBOUND_MEDIA_BODY_MISSING");

  const output = createWriteStream(destination, {
    flags: "wx",
    mode: 0o600,
  });
  let bytesSeen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesSeen += chunk.byteLength;
      if (bytesSeen > MAX_INBOUND_MEDIA_BYTES) {
        callback(new InboundMediaError("INBOUND_MEDIA_RESPONSE_TOO_LARGE"));
        return;
      }
      callback(null, chunk);
    },
  });
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      limiter,
      decipher,
      output,
    );
  } catch (error) {
    output.destroy();
    await rm(destination, { force: true }).catch(() => undefined);
    if (error instanceof InboundMediaError) throw error;
    throw new InboundMediaError("INBOUND_MEDIA_DECRYPT_FAILED");
  }
}

function parseAesKey(descriptor: InboundAttachmentDescriptor): Buffer {
  if (descriptor.type === "image" && descriptor.imageAesKeyHex !== null) {
    if (!/^[0-9a-fA-F]{32}$/.test(descriptor.imageAesKeyHex))
      throw new InboundMediaError("INBOUND_MEDIA_AES_KEY_INVALID");
    return Buffer.from(descriptor.imageAesKeyHex, "hex");
  }
  if (descriptor.aesKey === null)
    throw new InboundMediaError("INBOUND_MEDIA_AES_KEY_MISSING");
  const decoded = Buffer.from(descriptor.aesKey, "base64");
  if (decoded.byteLength === 16) return decoded;
  if (
    decoded.byteLength === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new InboundMediaError("INBOUND_MEDIA_AES_KEY_INVALID");
}

function resolveDownloadUrl(descriptor: InboundAttachmentDescriptor): string {
  const base = new URL(INBOUND_MEDIA_CDN_BASE_URL);
  if (descriptor.fullUrl !== null) {
    let parsed: URL;
    try {
      parsed = new URL(descriptor.fullUrl);
    } catch {
      throw new InboundMediaError("INBOUND_MEDIA_URL_INVALID");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== base.origin ||
      parsed.pathname !== `${base.pathname}/download` ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== ""
    )
      throw new InboundMediaError("INBOUND_MEDIA_URL_INVALID");
    return parsed.toString();
  }
  if (descriptor.encryptQueryParam === null)
    throw new InboundMediaError("INBOUND_MEDIA_URL_MISSING");
  const url = new URL(`${INBOUND_MEDIA_CDN_BASE_URL}/download`);
  url.searchParams.set("encrypted_query_param", descriptor.encryptQueryParam);
  return url.toString();
}
