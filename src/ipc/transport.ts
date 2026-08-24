import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname } from "node:path";

import { z } from "zod";

const SCHEMA_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

const statusPayloadSchema = z.strictObject({ command: z.literal("status") });
const loginPayloadSchema = z.strictObject({ command: z.literal("login") });
const doctorPayloadSchema = z.strictObject({ command: z.literal("doctor") });
const pairingInvitationPayloadSchema = z.strictObject({
  command: z.literal("pairing_invitation"),
});
const resetPayloadSchema = z.strictObject({ command: z.literal("reset") });
const sendTextPayloadSchema = z.strictObject({
  command: z.literal("send_text"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  text: z.string().refine((value) => {
    const length = Array.from(value).length;
    return length >= 1 && length <= 4000;
  }),
});
const sendFilePayloadSchema = z.strictObject({
  command: z.literal("send_file"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
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
  byteLength: z.number().int().positive().max(MAX_FILE_BYTES),
});

const payloadSchema = z.discriminatedUnion("command", [
  statusPayloadSchema,
  loginPayloadSchema,
  doctorPayloadSchema,
  pairingInvitationPayloadSchema,
  resetPayloadSchema,
  sendTextPayloadSchema,
  sendFilePayloadSchema,
]);

const requestEnvelopeSchema = z.strictObject({
  kind: z.literal("request"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  appVersion: z.string().min(1).max(100),
  capability: z.string().min(32).max(512),
  requestId: z.string().min(1).max(128),
  payload: z.unknown(),
});

const responseEnvelopeSchema = z.strictObject({
  kind: z.literal("response"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  appVersion: z.string(),
  requestId: z.string(),
  body: z.unknown(),
});

const ipcEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("qr"),
    content: z
      .string()
      .min(1)
      .max(16 * 1024),
  }),
  z.strictObject({
    type: z.literal("login_state"),
    state: z.string().min(1).max(64),
  }),
  z.strictObject({ type: z.literal("verify_code_required") }),
]);

const eventEnvelopeSchema = z.strictObject({
  kind: z.literal("event"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  appVersion: z.string(),
  requestId: z.string(),
  event: ipcEventSchema,
});

const inputRequestEnvelopeSchema = z.strictObject({
  kind: z.literal("input_request"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  appVersion: z.string(),
  requestId: z.string(),
  input: z.literal("verify_code"),
});

const inputResponseEnvelopeSchema = z.strictObject({
  kind: z.literal("input_response"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  appVersion: z.string(),
  requestId: z.string(),
  value: z.string().max(100).nullable(),
});

const fileReadyEnvelopeSchema = z.strictObject({
  kind: z.literal("file_ready"),
  schemaVersion: z.literal(SCHEMA_VERSION),
  appVersion: z.string(),
  requestId: z.string(),
});

export type IpcClientPayload = z.infer<typeof payloadSchema>;

export type IpcServerRequest =
  | ({ requestId: string } & Exclude<
      IpcClientPayload,
      { command: "send_file" }
    >)
  | {
      requestId: string;
      command: "send_file";
      idempotencyKey: string;
      fileName: string;
      byteLength: number;
      contentSha256: string;
      stagedPath: string;
    };

export type IpcEvent = z.infer<typeof ipcEventSchema>;

export type IpcConnectionContext = {
  emit(event: IpcEvent): Promise<void>;
  requestVerifyCode(): Promise<string | null>;
};

export type IpcServerOptions = {
  endpoint: string;
  tempDir: string;
  capability: string;
  appVersion: string;
  maximumStagedBytes?: number;
  maximumStagedFiles?: number;
  handle(
    request: IpcServerRequest,
    context: IpcConnectionContext,
  ): Promise<unknown>;
};

export type RequestIpcOptions = {
  endpoint: string;
  capability: string;
  appVersion: string;
  requestId: string;
  payload: IpcClientPayload;
  filePath?: string;
  onEvent?(event: IpcEvent): Promise<void> | void;
  onVerifyCode?(): Promise<string | null>;
};

export class IpcTransportError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IpcTransportError";
  }
}

class SocketReader {
  private readonly iterator: AsyncIterator<Buffer | string>;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  public constructor(socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]();
  }

  public async readFrame(): Promise<unknown> {
    const header = await this.readExactly(4);
    const byteLength = header.readUInt32BE(0);
    if (byteLength === 0 || byteLength > MAX_FRAME_BYTES) {
      throw new IpcTransportError(
        "IPC_FRAME_INVALID",
        "The IPC frame length is invalid.",
      );
    }
    const body = await this.readExactly(byteLength);
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      throw new IpcTransportError(
        "IPC_FRAME_INVALID",
        "The IPC frame is not valid JSON.",
      );
    }
  }

  public async readExactly(byteLength: number): Promise<Buffer> {
    while (this.pending.byteLength < byteLength) {
      const next = await this.iterator.next();
      if (next.done) {
        throw new IpcTransportError(
          "IPC_TRUNCATED",
          "The IPC connection ended unexpectedly.",
        );
      }
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      this.pending =
        this.pending.byteLength === 0
          ? chunk
          : Buffer.concat([this.pending, chunk]);
    }
    const result = this.pending.subarray(0, byteLength);
    this.pending = this.pending.subarray(byteLength);
    return result;
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

async function writeBuffer(socket: Socket, buffer: Buffer): Promise<void> {
  if (socket.write(buffer)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
  });
}

async function writeFrame(socket: Socket, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BYTES) {
    throw new IpcTransportError(
      "IPC_FRAME_TOO_LARGE",
      "The IPC frame is too large.",
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  await writeBuffer(socket, Buffer.concat([header, body]));
}

function publicFailure(code: string): {
  ok: false;
  error: { code: string; retryable: false };
} {
  return { ok: false, error: { code, retryable: false } };
}

function busyFailure(): {
  ok: false;
  error: { code: "IPC_BUSY"; retryable: true };
} {
  return { ok: false, error: { code: "IPC_BUSY", retryable: true } };
}

async function connect(endpoint: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(endpoint);
    const onError = (error: Error): void => {
      socket.destroy();
      reject(new IpcTransportError("IPC_UNAVAILABLE", error.message));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function endpointIsActive(endpoint: string): Promise<boolean> {
  try {
    const socket = await connect(endpoint);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

async function removeOwnedStaleSocket(endpoint: string): Promise<void> {
  try {
    await access(endpoint, constants.F_OK);
  } catch {
    return;
  }
  if (await endpointIsActive(endpoint)) {
    throw new IpcTransportError(
      "IPC_ALREADY_RUNNING",
      "The daemon is already running.",
    );
  }
  const metadata = await lstat(endpoint);
  if (
    !metadata.isSocket() ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new IpcTransportError(
      "IPC_ENDPOINT_UNSAFE",
      "The IPC endpoint is not an owned stale socket.",
    );
  }
  await unlink(endpoint);
}

export class IpcServer {
  private server: Server | null = null;
  private ready = false;
  private readonly sockets = new Set<Socket>();
  private readonly connectionTasks = new Set<Promise<void>>();
  private stagedBytes = 0;
  private stagedFiles = 0;

  public constructor(private readonly options: IpcServerOptions) {}

  public async start(): Promise<void> {
    if (this.server !== null)
      throw new IpcTransportError("IPC_ALREADY_RUNNING", "IPC is started.");
    await mkdir(this.options.tempDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await mkdir(dirname(this.options.endpoint), {
        recursive: true,
        mode: 0o700,
      });
      await removeOwnedStaleSocket(this.options.endpoint);
    }

    const server = createServer((socket) => {
      if (!this.ready) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      const task = this.serve(socket);
      this.connectionTasks.add(task);
      void task.finally(() => this.connectionTasks.delete(task));
    });
    server.maxConnections = 256;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(this.options.endpoint, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    try {
      if (process.platform !== "win32")
        await chmod(this.options.endpoint, 0o600);
      await this.removeStaleTemporaryFiles();
      this.ready = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.ready = false;
    if (server === null) return;
    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    for (const socket of this.sockets) socket.destroy();
    await closing;
    await Promise.allSettled([...this.connectionTasks]);
  }

  private async removeStaleTemporaryFiles(): Promise<void> {
    const entries = await readdir(this.options.tempDir, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            !entry.isDirectory() &&
            (/^[0-9a-f-]{36}\.upload$/.test(entry.name) ||
              /^\.send-wechat-[0-9a-f-]{36}\.encrypted$/.test(entry.name)),
        )
        .map((entry) =>
          rm(`${this.options.tempDir}/${entry.name}`, { force: true }),
        ),
    );
  }

  private async serve(socket: Socket): Promise<void> {
    const reader = new SocketReader(socket);
    let requestId = "unknown";
    let stagedPath: string | null = null;
    let stagedReservation = 0;
    let writeTail: Promise<void> = Promise.resolve();
    const serializedWrite = async (value: unknown): Promise<void> => {
      writeTail = writeTail.then(() => writeFrame(socket, value));
      await writeTail;
    };

    try {
      const envelope = requestEnvelopeSchema.parse(await reader.readFrame());
      requestId = envelope.requestId;
      if (!safeEqual(envelope.capability, this.options.capability)) {
        await this.respond(
          serializedWrite,
          requestId,
          publicFailure("IPC_UNAUTHORIZED"),
        );
        return;
      }
      if (envelope.appVersion !== this.options.appVersion) {
        await this.respond(
          serializedWrite,
          requestId,
          publicFailure("VERSION_MISMATCH"),
        );
        return;
      }
      const payload = payloadSchema.parse(envelope.payload);
      let request: IpcServerRequest;
      if (payload.command === "send_file") {
        const maximumBytes =
          this.options.maximumStagedBytes ?? 500 * 1024 * 1024;
        const maximumFiles = this.options.maximumStagedFiles ?? 100;
        if (
          payload.byteLength > maximumBytes - this.stagedBytes ||
          this.stagedFiles >= maximumFiles
        ) {
          await this.respond(serializedWrite, requestId, busyFailure());
          return;
        }
        stagedReservation = payload.byteLength;
        this.stagedBytes += payload.byteLength;
        this.stagedFiles += 1;
        await serializedWrite({
          kind: "file_ready",
          schemaVersion: SCHEMA_VERSION,
          appVersion: this.options.appVersion,
          requestId,
        });
        const staged = await this.stageFile(reader, payload.byteLength);
        stagedPath = staged.path;
        request = {
          requestId,
          ...payload,
          stagedPath: staged.path,
          contentSha256: staged.sha256,
        };
      } else {
        request = { requestId, ...payload };
      }

      const context: IpcConnectionContext = {
        emit: async (event) => {
          await serializedWrite({
            kind: "event",
            schemaVersion: SCHEMA_VERSION,
            appVersion: this.options.appVersion,
            requestId,
            event,
          });
        },
        requestVerifyCode: async () => {
          await serializedWrite({
            kind: "input_request",
            schemaVersion: SCHEMA_VERSION,
            appVersion: this.options.appVersion,
            requestId,
            input: "verify_code",
          });
          const response = inputResponseEnvelopeSchema.parse(
            await reader.readFrame(),
          );
          if (
            response.requestId !== requestId ||
            response.appVersion !== this.options.appVersion
          ) {
            throw new IpcTransportError(
              "IPC_FRAME_INVALID",
              "The IPC input response does not match.",
            );
          }
          return response.value;
        },
      };
      const result = await this.options.handle(request, context);
      await this.respond(serializedWrite, requestId, result);
    } catch {
      try {
        await this.respond(
          serializedWrite,
          requestId,
          publicFailure("LOCAL_FAILURE"),
        );
      } catch {
        // The peer may already have closed. No sensitive detail is sent or logged here.
      }
    } finally {
      socket.end();
      if (stagedPath !== null) await unlink(stagedPath).catch(() => undefined);
      if (stagedReservation > 0) {
        this.stagedBytes -= stagedReservation;
        this.stagedFiles -= 1;
      }
    }
  }

  private async stageFile(
    reader: SocketReader,
    byteLength: number,
  ): Promise<{ path: string; sha256: string }> {
    const path = `${this.options.tempDir}/${randomUUID()}.upload`;
    const handle = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      let remaining = byteLength;
      while (remaining > 0) {
        const chunk = await reader.readExactly(Math.min(64 * 1024, remaining));
        await handle.write(chunk);
        hash.update(chunk);
        remaining -= chunk.byteLength;
      }
      await handle.sync();
      return { path, sha256: hash.digest("hex") };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async respond(
    write: (value: unknown) => Promise<void>,
    requestId: string,
    body: unknown,
  ): Promise<void> {
    await write({
      kind: "response",
      schemaVersion: SCHEMA_VERSION,
      appVersion: this.options.appVersion,
      requestId,
      body,
    });
  }
}

export async function requestIpc(options: RequestIpcOptions): Promise<unknown> {
  const payload = payloadSchema.parse(options.payload);
  if (payload.command === "send_file" && options.filePath === undefined) {
    throw new IpcTransportError(
      "FILE_REQUIRED",
      "A file path is required for send_file.",
    );
  }
  if (payload.command !== "send_file" && options.filePath !== undefined) {
    throw new IpcTransportError(
      "FILE_UNEXPECTED",
      "A file is only valid for send_file.",
    );
  }

  let sourceMetadata: Awaited<ReturnType<typeof lstat>> | null = null;
  if (payload.command === "send_file") {
    sourceMetadata = await lstat(options.filePath as string);
    if (
      !sourceMetadata.isFile() ||
      sourceMetadata.size !== payload.byteLength
    ) {
      throw new IpcTransportError(
        "FILE_CHANGED",
        "The source file is not a regular file of the expected size.",
      );
    }
  }

  const socket = await connect(options.endpoint);
  const reader = new SocketReader(socket);
  try {
    await writeFrame(socket, {
      kind: "request",
      schemaVersion: SCHEMA_VERSION,
      appVersion: options.appVersion,
      capability: options.capability,
      requestId: options.requestId,
      payload,
    });
    if (payload.command === "send_file") {
      const initialFrame = await reader.readFrame();
      const initialResponse = decodeResponse(initialFrame, options);
      if (initialResponse.kind === "response") return initialResponse.body;
      const ready = fileReadyEnvelopeSchema.safeParse(initialFrame);
      if (
        !ready.success ||
        ready.data.requestId !== options.requestId ||
        ready.data.appVersion !== options.appVersion
      ) {
        throw new IpcTransportError(
          "IPC_FRAME_INVALID",
          "The IPC file acknowledgement is invalid.",
        );
      }
      const path = options.filePath as string;
      const metadata = await lstat(path);
      if (
        sourceMetadata === null ||
        !metadata.isFile() ||
        metadata.size !== sourceMetadata.size ||
        metadata.mtimeMs !== sourceMetadata.mtimeMs
      ) {
        throw new IpcTransportError(
          "FILE_CHANGED",
          "The source file is not a regular file of the expected size.",
        );
      }
      const source = (await import("node:fs")).createReadStream(path);
      let sent = 0;
      for await (const chunk of source as AsyncIterable<
        Buffer<ArrayBufferLike>
      >) {
        sent += chunk.byteLength;
        if (sent > payload.byteLength) {
          source.destroy();
          throw new IpcTransportError(
            "FILE_CHANGED",
            "The source file changed while it was read.",
          );
        }
        await writeBuffer(socket, chunk);
      }
      if (sent !== payload.byteLength) {
        throw new IpcTransportError(
          "FILE_CHANGED",
          "The source file changed while it was read.",
        );
      }
    }

    for (;;) {
      const frame = await reader.readFrame();
      const response = decodeResponse(frame, options);
      if (response.kind === "response") return response.body;
      const event = eventEnvelopeSchema.safeParse(frame);
      if (event.success) {
        if (
          event.data.requestId !== options.requestId ||
          event.data.appVersion !== options.appVersion
        ) {
          throw new IpcTransportError(
            "IPC_FRAME_INVALID",
            "The IPC event does not match the request.",
          );
        }
        await options.onEvent?.(event.data.event);
        continue;
      }
      const input = inputRequestEnvelopeSchema.safeParse(frame);
      if (input.success) {
        if (
          input.data.requestId !== options.requestId ||
          input.data.appVersion !== options.appVersion
        ) {
          throw new IpcTransportError(
            "IPC_FRAME_INVALID",
            "The IPC input request does not match.",
          );
        }
        const value =
          options.onVerifyCode === undefined
            ? null
            : await options.onVerifyCode();
        await writeFrame(socket, {
          kind: "input_response",
          schemaVersion: SCHEMA_VERSION,
          appVersion: options.appVersion,
          requestId: options.requestId,
          value,
        });
        continue;
      }
      throw new IpcTransportError(
        "IPC_FRAME_INVALID",
        "The IPC peer sent an invalid frame.",
      );
    }
  } finally {
    socket.destroy();
  }
}

function decodeResponse(
  frame: unknown,
  options: Pick<RequestIpcOptions, "appVersion" | "requestId">,
): { kind: "not_response" } | { kind: "response"; body: unknown } {
  const response = responseEnvelopeSchema.safeParse(frame);
  if (!response.success) return { kind: "not_response" };
  const versionMismatch =
    typeof response.data.body === "object" &&
    response.data.body !== null &&
    "error" in response.data.body &&
    typeof response.data.body.error === "object" &&
    response.data.body.error !== null &&
    "code" in response.data.body.error &&
    response.data.body.error.code === "VERSION_MISMATCH";
  if (
    response.data.requestId !== options.requestId ||
    (response.data.appVersion !== options.appVersion && !versionMismatch)
  ) {
    throw new IpcTransportError(
      "IPC_FRAME_INVALID",
      "The IPC response does not match the request.",
    );
  }
  return { kind: "response", body: response.data.body };
}
