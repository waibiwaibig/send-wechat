import {
  createHash,
  randomBytes as nodeRandomBytes,
  type Hash,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import { RelayProtocolError, type RemoteCommand } from "./protocol.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const MAX_ACTIVE_UPLOADS = 10;
const MAX_RESERVED_BYTES = 500 * 1024 * 1024;
const UPLOAD_IDLE_MS = 10 * 60 * 1000;

type FileCommand = Extract<RemoteCommand, { command: `file_${string}` }>;
type Upload = {
  readonly key: string;
  readonly uploadId: string;
  readonly deviceId: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly path: string;
  readonly handle: FileHandle;
  readonly hash: Hash;
  received: number;
  lastActivity: number;
  lastChunkOffset: number | null;
  lastChunkHash: string | null;
};

export class HubRemoteFileUploads {
  private readonly uploads = new Map<string, Upload>();
  private initialization: Promise<void> | null = null;

  public constructor(
    private readonly dependencies: {
      readonly temporaryDirectory: string;
      readonly now?: () => number;
      readonly requestId: () => string;
      readonly deliver: (request: {
        requestId: string;
        command: "send_file";
        idempotencyKey: string;
        fileName: string;
        byteLength: number;
        contentSha256: string;
        stagedPath: string;
      }) => Promise<unknown>;
    },
  ) {}

  public async execute(
    deviceId: string,
    command: RemoteCommand,
  ): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId))
      throw new RelayProtocolError("RELAY_DEVICE_UNKNOWN");
    if (!command.command.startsWith("file_"))
      throw new RelayProtocolError("REMOTE_COMMAND_UNSUPPORTED");
    await this.initialize();
    await this.prune();
    const fileCommand = command as FileCommand;
    switch (fileCommand.command) {
      case "file_begin":
        return await this.begin(deviceId, fileCommand);
      case "file_chunk":
        return await this.chunk(deviceId, fileCommand);
      case "file_commit":
        return await this.commit(deviceId, fileCommand);
      case "file_abort":
        await this.remove(this.key(deviceId, fileCommand.uploadId));
        return { ok: true, state: "aborted" };
    }
  }

  public async close(): Promise<void> {
    await Promise.allSettled(
      [...this.uploads.keys()].map((key) => this.remove(key)),
    );
  }

  private async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.dependencies.temporaryDirectory, {
        recursive: true,
        mode: 0o700,
      });
      if (process.platform !== "win32")
        await chmod(this.dependencies.temporaryDirectory, 0o700);
      const entries = await readdir(this.dependencies.temporaryDirectory, {
        withFileTypes: true,
      });
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              /^remote-[a-f0-9]{64}\.upload$/.test(entry.name),
          )
          .map((entry) =>
            rm(join(this.dependencies.temporaryDirectory, entry.name), {
              force: true,
            }),
          ),
      );
    })();
    await this.initialization;
  }

  private async begin(
    deviceId: string,
    command: Extract<FileCommand, { command: "file_begin" }>,
  ): Promise<{ ok: true; nextOffset: number }> {
    assertUploadId(command.uploadId);
    assertFileMetadata(command.fileName, command.byteLength);
    const key = this.key(deviceId, command.uploadId);
    const existing = this.uploads.get(key);
    if (existing !== undefined) {
      if (
        existing.fileName !== command.fileName ||
        existing.byteLength !== command.byteLength
      )
        throw new RelayProtocolError("REMOTE_UPLOAD_CONFLICT");
      existing.lastActivity = this.now();
      return { ok: true, nextOffset: existing.received };
    }
    const reserved = [...this.uploads.values()].reduce(
      (total, upload) => total + upload.byteLength,
      0,
    );
    if (
      this.uploads.size >= MAX_ACTIVE_UPLOADS ||
      command.byteLength > MAX_RESERVED_BYTES - reserved
    )
      throw new RelayProtocolError("REMOTE_UPLOAD_BUSY", true);
    const fileId = createHash("sha256")
      .update(deviceId)
      .update("\0")
      .update(command.uploadId)
      .digest("hex");
    const path = join(
      this.dependencies.temporaryDirectory,
      `remote-${fileId}.upload`,
    );
    const handle = await open(path, "wx", 0o600);
    this.uploads.set(key, {
      key,
      uploadId: command.uploadId,
      deviceId,
      fileName: command.fileName,
      byteLength: command.byteLength,
      path,
      handle,
      hash: createHash("sha256"),
      received: 0,
      lastActivity: this.now(),
      lastChunkOffset: null,
      lastChunkHash: null,
    });
    return { ok: true, nextOffset: 0 };
  }

  private async chunk(
    deviceId: string,
    command: Extract<FileCommand, { command: "file_chunk" }>,
  ): Promise<{ ok: true; nextOffset: number }> {
    assertUploadId(command.uploadId);
    const upload = this.uploads.get(this.key(deviceId, command.uploadId));
    if (upload === undefined)
      throw new RelayProtocolError("REMOTE_UPLOAD_NOT_FOUND");
    const data = decodeChunk(command.data);
    const chunkHash = createHash("sha256").update(data).digest("hex");
    if (command.offset !== upload.received) {
      if (
        command.offset === upload.lastChunkOffset &&
        chunkHash === upload.lastChunkHash
      ) {
        upload.lastActivity = this.now();
        return { ok: true, nextOffset: upload.received };
      }
      throw new RelayProtocolError("REMOTE_UPLOAD_OFFSET_MISMATCH");
    }
    if (data.byteLength > upload.byteLength - upload.received)
      throw new RelayProtocolError("REMOTE_UPLOAD_SIZE_MISMATCH");
    await writeExactly(upload.handle, data, upload.received);
    upload.hash.update(data);
    upload.lastChunkOffset = command.offset;
    upload.lastChunkHash = chunkHash;
    upload.received += data.byteLength;
    upload.lastActivity = this.now();
    return { ok: true, nextOffset: upload.received };
  }

  private async commit(
    deviceId: string,
    command: Extract<FileCommand, { command: "file_commit" }>,
  ): Promise<unknown> {
    assertUploadId(command.uploadId);
    if (!/^[a-f0-9]{64}$/.test(command.contentSha256))
      throw new RelayProtocolError("REMOTE_UPLOAD_HASH_INVALID");
    const key = this.key(deviceId, command.uploadId);
    const upload = this.uploads.get(key);
    if (upload === undefined)
      throw new RelayProtocolError("REMOTE_UPLOAD_NOT_FOUND");
    if (upload.received !== upload.byteLength)
      throw new RelayProtocolError("REMOTE_UPLOAD_SIZE_MISMATCH");
    const actualHash = upload.hash.digest("hex");
    if (actualHash !== command.contentSha256) {
      await this.remove(key);
      throw new RelayProtocolError("REMOTE_UPLOAD_HASH_MISMATCH");
    }
    await upload.handle.sync();
    await upload.handle.close();
    this.uploads.delete(key);
    try {
      return await this.dependencies.deliver({
        requestId: this.dependencies.requestId(),
        command: "send_file",
        idempotencyKey: command.idempotencyKey,
        fileName: upload.fileName,
        byteLength: upload.byteLength,
        contentSha256: actualHash,
        stagedPath: upload.path,
      });
    } finally {
      await rm(upload.path, { force: true });
    }
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - UPLOAD_IDLE_MS;
    await Promise.all(
      [...this.uploads]
        .filter(([, upload]) => upload.lastActivity < cutoff)
        .map(([key]) => this.remove(key)),
    );
  }

  private async remove(key: string): Promise<void> {
    const upload = this.uploads.get(key);
    if (upload === undefined) return;
    this.uploads.delete(key);
    await upload.handle.close().catch(() => undefined);
    await rm(upload.path, { force: true });
  }

  private key(deviceId: string, uploadId: string): string {
    return `${deviceId}:${uploadId}`;
  }

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }
}

export class RemoteFileSender {
  public constructor(
    private readonly dependencies: {
      readonly execute: (command: RemoteCommand) => Promise<unknown>;
      readonly randomBytes?: (size: number) => Buffer;
    },
  ) {}

  public async send(input: {
    filePath: string;
    fileName: string;
    byteLength: number;
    idempotencyKey: string;
  }): Promise<unknown> {
    const initial = await lstat(input.filePath);
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.size !== input.byteLength
    )
      throw new RelayProtocolError("FILE_CHANGED");
    const uploadBytes = (this.dependencies.randomBytes ?? randomBytesFallback)(
      16,
    );
    if (uploadBytes.byteLength !== 16)
      throw new RelayProtocolError("REMOTE_UPLOAD_ID_INVALID");
    const uploadId = uploadBytes.toString("base64url");
    let begun = false;
    try {
      assertUploadAck(
        await this.dependencies.execute({
          command: "file_begin",
          uploadId,
          fileName: input.fileName,
          byteLength: input.byteLength,
        }),
        0,
      );
      begun = true;
      const hash = createHash("sha256");
      let offset = 0;
      const source = createReadStream(input.filePath, {
        highWaterMark: MAX_CHUNK_BYTES,
      });
      for await (const value of source) {
        const chunk = Buffer.from(value as Buffer);
        if (offset + chunk.byteLength > input.byteLength) {
          source.destroy();
          throw new RelayProtocolError("FILE_CHANGED");
        }
        hash.update(chunk);
        offset += chunk.byteLength;
        assertUploadAck(
          await this.dependencies.execute({
            command: "file_chunk",
            uploadId,
            offset: offset - chunk.byteLength,
            data: chunk.toString("base64url"),
          }),
          offset,
        );
      }
      const final = await lstat(input.filePath);
      if (
        offset !== input.byteLength ||
        !final.isFile() ||
        final.size !== initial.size ||
        final.mtimeMs !== initial.mtimeMs ||
        final.ino !== initial.ino ||
        final.dev !== initial.dev
      )
        throw new RelayProtocolError("FILE_CHANGED");
      const result = await this.dependencies.execute({
        command: "file_commit",
        uploadId,
        idempotencyKey: input.idempotencyKey,
        contentSha256: hash.digest("hex"),
      });
      throwIfProtocolFailure(result);
      return result;
    } catch (error) {
      if (begun)
        await this.dependencies
          .execute({ command: "file_abort", uploadId })
          .catch(() => undefined);
      throw error;
    }
  }
}

function assertUploadId(value: string): void {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value))
    throw new RelayProtocolError("REMOTE_UPLOAD_ID_INVALID");
}

function assertFileMetadata(fileName: string, byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > MAX_FILE_BYTES ||
    fileName.length === 0 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(fileName) ||
    Buffer.byteLength(fileName, "utf8") > 255
  )
    throw new RelayProtocolError("REMOTE_UPLOAD_METADATA_INVALID");
}

function decodeChunk(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{1,699051}$/.test(value))
    throw new RelayProtocolError("REMOTE_UPLOAD_CHUNK_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > MAX_CHUNK_BYTES ||
    decoded.toString("base64url") !== value
  )
    throw new RelayProtocolError("REMOTE_UPLOAD_CHUNK_INVALID");
  return decoded;
}

async function writeExactly(
  handle: FileHandle,
  data: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < data.byteLength) {
    const result = await handle.write(
      data,
      written,
      data.byteLength - written,
      position + written,
    );
    if (result.bytesWritten <= 0)
      throw new RelayProtocolError("REMOTE_UPLOAD_WRITE_FAILED");
    written += result.bytesWritten;
  }
}

function assertUploadAck(value: unknown, expectedOffset: number): void {
  throwIfProtocolFailure(value);
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).ok !== true ||
    (value as Record<string, unknown>).nextOffset !== expectedOffset
  )
    throw new RelayProtocolError("REMOTE_UPLOAD_RESPONSE_INVALID");
}

function throwIfProtocolFailure(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return;
  const code = (error as Record<string, unknown>).code;
  const retryable = (error as Record<string, unknown>).retryable;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code))
    throw new RelayProtocolError(code, retryable === true);
}

function randomBytesFallback(size: number): Buffer {
  return nodeRandomBytes(size);
}
