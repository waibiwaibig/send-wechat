import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

import { z } from "zod";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 12 * 1024 * 1024;

const encryptedFrameSchema = z
  .object({
    v: z.literal(1),
    kind: z.enum(["pair", "device"]),
    credentialId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    nonce: z.string().length(16).regex(BASE64URL),
    ciphertext: z.string().min(1).max(11_184_811).regex(BASE64URL),
    tag: z.string().length(22).regex(BASE64URL),
  })
  .strict();

export type RelayFrameKind = "pair" | "device";

export class RelayFrameError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "RelayFrameError";
  }
}

export class RelayCipher {
  private readonly randomBytes: (size: number) => Buffer;

  public constructor(
    dependencies: { randomBytes?: (size: number) => Buffer } = {},
  ) {
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  }

  public seal(input: {
    kind: RelayFrameKind;
    credentialId: string;
    key: Buffer;
    plaintext: Buffer;
  }): Buffer {
    assertKey(input.key);
    if (
      input.plaintext.byteLength === 0 ||
      input.plaintext.byteLength > MAX_PLAINTEXT_BYTES
    )
      throw new RelayFrameError("RELAY_FRAME_INVALID");
    const nonce = this.randomBytes(12);
    if (nonce.byteLength !== 12)
      throw new RelayFrameError("RELAY_FRAME_INVALID");
    const aad = associatedData(input.kind, input.credentialId);
    const cipher = createCipheriv("aes-256-gcm", input.key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(input.plaintext),
      cipher.final(),
    ]);
    const frame = encryptedFrameSchema.parse({
      v: 1,
      kind: input.kind,
      credentialId: input.credentialId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
    return Buffer.from(JSON.stringify(frame), "utf8");
  }

  public header(frame: Buffer): {
    kind: RelayFrameKind;
    credentialId: string;
  } {
    const parsed = parseFrame(frame);
    return {
      kind: parsed.kind,
      credentialId: parsed.credentialId,
    };
  }

  public open(input: {
    frame: Buffer;
    expectedKind: RelayFrameKind;
    expectedCredentialId: string;
    key: Buffer;
  }): Buffer {
    assertKey(input.key);
    const parsed = parseFrame(input.frame);
    if (
      parsed.kind !== input.expectedKind ||
      parsed.credentialId !== input.expectedCredentialId
    )
      throw new RelayFrameError("RELAY_FRAME_INVALID");

    let nonce: Buffer;
    let ciphertext: Buffer;
    let tag: Buffer;
    try {
      nonce = decodeBase64Url(parsed.nonce, 12);
      ciphertext = decodeBase64Url(parsed.ciphertext);
      tag = decodeBase64Url(parsed.tag, 16);
    } catch {
      throw new RelayFrameError("RELAY_FRAME_INVALID");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", input.key, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(associatedData(parsed.kind, parsed.credentialId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (
        plaintext.byteLength === 0 ||
        plaintext.byteLength > MAX_PLAINTEXT_BYTES
      )
        throw new RelayFrameError("RELAY_FRAME_INVALID");
      return plaintext;
    } catch (error) {
      if (error instanceof RelayFrameError) throw error;
      throw new RelayFrameError("RELAY_FRAME_AUTH_FAILED");
    }
  }
}

function parseFrame(frame: Buffer): z.infer<typeof encryptedFrameSchema> {
  if (frame.byteLength === 0 || frame.byteLength > MAX_FRAME_BYTES)
    throw new RelayFrameError("RELAY_FRAME_INVALID");
  let raw: unknown;
  try {
    raw = JSON.parse(frame.toString("utf8"));
  } catch {
    throw new RelayFrameError("RELAY_FRAME_INVALID");
  }
  const parsed = encryptedFrameSchema.safeParse(raw);
  if (!parsed.success) throw new RelayFrameError("RELAY_FRAME_INVALID");
  return parsed.data;
}

function associatedData(kind: RelayFrameKind, credentialId: string): Buffer {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(credentialId))
    throw new RelayFrameError("RELAY_FRAME_INVALID");
  return Buffer.from(`send-wechat-relay\0v1\0${kind}\0${credentialId}`, "utf8");
}

function assertKey(key: Buffer): void {
  if (key.byteLength !== 32) throw new RelayFrameError("RELAY_FRAME_INVALID");
}

function decodeBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value)) throw new Error("invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  )
    throw new Error("invalid base64url");
  return decoded;
}
