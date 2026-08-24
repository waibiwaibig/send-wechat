import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  fetchWithSystemProxy,
  type PlatformFetch,
} from "../platform/network.js";
import { RelayCipher, RelayFrameError } from "./crypto.js";
import type { PairingHub } from "./pairing.js";
import type {
  ClientRelayCredential,
  RelayCredential,
} from "../storage/relay-credential-store.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_RELAY_FRAME_BYTES = 12 * 1024 * 1024;
const remoteCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("status") }),
  z.strictObject({
    command: z.literal("send_text"),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    text: z.string().refine((value) => {
      const length = Array.from(value).length;
      return length >= 1 && length <= 4000;
    }),
  }),
  z.strictObject({
    command: z.literal("file_begin"),
    uploadId: z.string().length(22).regex(BASE64URL),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          !/[\u0000-\u001f\u007f]/.test(value) &&
          Buffer.byteLength(value, "utf8") <= 255,
      ),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
  }),
  z.strictObject({
    command: z.literal("file_chunk"),
    uploadId: z.string().length(22).regex(BASE64URL),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024 * 1024),
    data: z.string().min(1).max(699_051).regex(BASE64URL),
  }),
  z.strictObject({
    command: z.literal("file_commit"),
    uploadId: z.string().length(22).regex(BASE64URL),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    command: z.literal("file_abort"),
    uploadId: z.string().length(22).regex(BASE64URL),
  }),
]);
const commandRequestSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("command_request"),
  nonce: z.string().length(22).regex(BASE64URL),
  command: remoteCommandSchema,
});
const commandResponseSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("command_result"),
  nonce: z.string().length(22).regex(BASE64URL),
  body: z.unknown(),
});

export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RelayTransportPort = {
  exchange(
    relayUrl: string,
    frame: Buffer,
  ): Promise<{ requestId: string; frame: Buffer }>;
};
type RelayCredentialStorePort = {
  load(): Promise<RelayCredential | null>;
  save(credential: RelayCredential): Promise<void>;
};

export class RelayProtocolError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(code);
    this.name = "RelayProtocolError";
  }
}

export class RelayHttpTransport implements RelayTransportPort {
  private readonly fetchImplementation: PlatformFetch;
  private readonly nextRequestId: () => string;

  public constructor(
    dependencies: {
      fetch?: PlatformFetch;
      requestId?: () => string;
    } = {},
  ) {
    this.fetchImplementation = dependencies.fetch ?? fetchWithSystemProxy;
    this.nextRequestId = dependencies.requestId ?? randomUUID;
  }

  public async exchange(
    relayValue: string,
    frame: Buffer,
  ): Promise<{ requestId: string; frame: Buffer }> {
    const relayUrl = validateRelayUrl(relayValue);
    if (frame.byteLength === 0 || frame.byteLength > MAX_RELAY_FRAME_BYTES)
      throw new RelayProtocolError("RELAY_FRAME_INVALID");
    const requestId = this.nextRequestId();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))
      throw new RelayProtocolError("RELAY_REQUEST_INVALID");
    let response: Response;
    try {
      response = await this.fetchImplementation(`${relayUrl}/v1/request`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-send-wechat-request-id": requestId,
        },
        body: new Uint8Array(frame),
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new RelayProtocolError("RELAY_UNAVAILABLE", true);
    }
    if (!response.ok) throw await parseRelayFailure(response);
    if (response.headers.get("content-type") !== "application/octet-stream")
      throw new RelayProtocolError("RELAY_RESPONSE_INVALID");
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_RELAY_FRAME_BYTES
    )
      throw new RelayProtocolError("RELAY_RESPONSE_INVALID");
    const responseFrame = Buffer.from(await response.arrayBuffer());
    if (
      responseFrame.byteLength === 0 ||
      responseFrame.byteLength > MAX_RELAY_FRAME_BYTES
    )
      throw new RelayProtocolError("RELAY_RESPONSE_INVALID");
    return { requestId, frame: responseFrame };
  }
}

export class RemoteRelayClient {
  private readonly cipher: RelayCipher;
  private readonly transport: RelayTransportPort;
  private readonly nextNonce: () => Buffer;

  public constructor(
    private readonly options: {
      readonly relayUrl: string;
      readonly credential: ClientRelayCredential;
      readonly cipher?: RelayCipher;
      readonly transport: RelayTransportPort;
      readonly nonce?: () => Buffer;
    },
  ) {
    this.cipher = options.cipher ?? new RelayCipher();
    this.transport = options.transport;
    this.nextNonce = options.nonce ?? (() => randomBytes(16));
  }

  public async execute(commandValue: RemoteCommand): Promise<unknown> {
    const command = remoteCommandSchema.safeParse(commandValue);
    if (!command.success)
      throw new RelayProtocolError("REMOTE_COMMAND_INVALID");
    const nonceBytes = this.nextNonce();
    if (nonceBytes.byteLength !== 16)
      throw new RelayProtocolError("REMOTE_COMMAND_INVALID");
    const nonce = nonceBytes.toString("base64url");
    const key = decodeKey(this.options.credential.deviceKey);
    const requestFrame = this.cipher.seal({
      kind: "device",
      credentialId: this.options.credential.deviceId,
      key,
      plaintext: encodeJson({
        v: 1,
        type: "command_request",
        nonce,
        command: command.data,
      }),
    });
    const response = await this.transport.exchange(
      this.options.relayUrl,
      requestFrame,
    );
    let plaintext: Buffer;
    try {
      plaintext = this.cipher.open({
        frame: response.frame,
        expectedKind: "device",
        expectedCredentialId: this.options.credential.deviceId,
        key,
      });
    } catch {
      throw new RelayProtocolError("RELAY_RESPONSE_AUTH_FAILED");
    }
    const decoded = parseJson(commandResponseSchema, plaintext);
    if (decoded === null || decoded.nonce !== nonce)
      throw new RelayProtocolError("RELAY_RESPONSE_INVALID");
    return decoded.body;
  }
}

export class HubRelayProcessor {
  public constructor(
    private readonly dependencies: {
      readonly cipher: RelayCipher;
      readonly credentialStore: RelayCredentialStorePort;
      readonly pairing: Pick<PairingHub, "accept">;
      readonly execute: (
        command: RemoteCommand,
        context: { deviceId: string },
      ) => Promise<unknown>;
    },
  ) {}

  public async process(requestFrame: Buffer): Promise<Buffer> {
    let header: ReturnType<RelayCipher["header"]>;
    try {
      header = this.dependencies.cipher.header(requestFrame);
    } catch {
      throw new RelayProtocolError("RELAY_REQUEST_INVALID");
    }
    if (header.kind === "pair")
      return this.dependencies.pairing.accept(requestFrame);

    const credential = await this.dependencies.credentialStore.load();
    if (credential === null || credential.role !== "hub")
      throw new RelayProtocolError("RELAY_HUB_NOT_READY");
    const device = credential.devices.find(
      ({ deviceId }) => deviceId === header.credentialId,
    );
    if (device === undefined)
      throw new RelayProtocolError("RELAY_DEVICE_UNKNOWN");
    const key = decodeKey(device.deviceKey);
    let plaintext: Buffer;
    try {
      plaintext = this.dependencies.cipher.open({
        frame: requestFrame,
        expectedKind: "device",
        expectedCredentialId: device.deviceId,
        key,
      });
    } catch (error) {
      if (
        error instanceof RelayFrameError &&
        error.code === "RELAY_FRAME_AUTH_FAILED"
      )
        throw new RelayProtocolError("RELAY_REQUEST_AUTH_FAILED");
      throw new RelayProtocolError("RELAY_REQUEST_INVALID");
    }
    const request = parseJson(commandRequestSchema, plaintext);
    if (request === null)
      throw new RelayProtocolError("REMOTE_COMMAND_INVALID");
    let body: unknown;
    try {
      body = await this.dependencies.execute(request.command, {
        deviceId: device.deviceId,
      });
    } catch (error) {
      body =
        error instanceof RelayProtocolError
          ? {
              ok: false,
              error: { code: error.code, retryable: error.retryable },
            }
          : {
              ok: false,
              error: { code: "REMOTE_EXECUTION_FAILED", retryable: false },
            };
    }
    return this.dependencies.cipher.seal({
      kind: "device",
      credentialId: device.deviceId,
      key,
      plaintext: encodeJson({
        v: 1,
        type: "command_result",
        nonce: request.nonce,
        body,
      }),
    });
  }
}

async function parseRelayFailure(
  response: Response,
): Promise<RelayProtocolError> {
  try {
    const raw = (await response.json()) as unknown;
    const parsed = z
      .strictObject({
        ok: z.literal(false),
        error: z.strictObject({
          code: z.string().regex(/^[A-Z0-9_]{1,128}$/),
          retryable: z.boolean(),
        }),
      })
      .safeParse(raw);
    if (parsed.success)
      return new RelayProtocolError(
        parsed.data.error.code,
        parsed.data.error.retryable,
      );
  } catch {
    // Invalid public relay errors are normalized below.
  }
  return new RelayProtocolError("RELAY_RESPONSE_INVALID");
}

function validateRelayUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RelayProtocolError("RELAY_URL_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.endsWith(".workers.dev") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new RelayProtocolError("RELAY_URL_INVALID");
  return parsed.toString().replace(/\/$/, "");
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value)
    throw new RelayProtocolError("RELAY_CREDENTIAL_INVALID");
  return key;
}

function encodeJson(value: unknown): Buffer {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RelayProtocolError("RELAY_RESPONSE_INVALID");
  }
  if (encoded === undefined)
    throw new RelayProtocolError("RELAY_RESPONSE_INVALID");
  return Buffer.from(encoded, "utf8");
}

function parseJson<T extends z.ZodType>(
  schema: T,
  value: Buffer,
): z.infer<T> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
