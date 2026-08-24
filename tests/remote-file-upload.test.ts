import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HubRemoteFileUploads,
  RemoteFileSender,
} from "../src/relay/uploads.js";
import type { RemoteCommand } from "../src/relay/protocol.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("remote files stream through the relay without cloud persistence", () => {
  it("uploads bounded chunks, verifies the whole hash, sends once, and removes staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-remote-file-"));
    directories.push(root);
    const source = join(root, "source.bin");
    const contents = Buffer.alloc(600 * 1024, 0x5a);
    await writeFile(source, contents);
    const delivered: Buffer[] = [];
    const uploads = new HubRemoteFileUploads({
      temporaryDirectory: join(root, "uploads"),
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
      deliver: async (request) => {
        delivered.push(await readFile(request.stagedPath));
        return {
          ok: true,
          command: "send",
          requestId: request.requestId,
          result: { state: "accepted" },
        };
      },
      requestId: () => "hub-request-1",
    });
    const commands: RemoteCommand[] = [];
    const deviceId = Buffer.alloc(16, 9).toString("base64url");
    const sender = new RemoteFileSender({
      execute: async (command) => {
        commands.push(command);
        return await uploads.execute(deviceId, command);
      },
      randomBytes: (size) => Buffer.alloc(size, 1),
    });

    await expect(
      sender.send({
        filePath: source,
        fileName: "source.bin",
        byteLength: contents.byteLength,
        idempotencyKey: "file-1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "send",
      result: { state: "accepted" },
    });
    expect(delivered).toEqual([contents]);
    expect(commands.map(({ command }) => command)).toEqual([
      "file_begin",
      "file_chunk",
      "file_chunk",
      "file_commit",
    ]);
    expect(
      commands
        .filter((command) => command.command === "file_chunk")
        .every(
          (command) =>
            Buffer.from(command.data, "base64url").length <= 512 * 1024,
        ),
    ).toBe(true);
    expect(await readdir(join(root, "uploads"))).toEqual([]);
    await uploads.close();
  });

  it("accepts an identical last-chunk retry but rejects changed offsets and hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-remote-file-"));
    directories.push(root);
    const uploads = new HubRemoteFileUploads({
      temporaryDirectory: join(root, "uploads"),
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
      deliver: vi.fn(),
      requestId: () => "request-1",
    });
    const uploadId = Buffer.alloc(16, 2).toString("base64url");
    const deviceId = Buffer.alloc(16, 3).toString("base64url");
    const begin = {
      command: "file_begin" as const,
      uploadId,
      fileName: "a.txt",
      byteLength: 3,
    };
    const chunk = {
      command: "file_chunk" as const,
      uploadId,
      offset: 0,
      data: Buffer.from("abc").toString("base64url"),
    };
    await uploads.execute(deviceId, begin);
    await expect(uploads.execute(deviceId, begin)).resolves.toEqual({
      ok: true,
      nextOffset: 0,
    });
    await expect(uploads.execute(deviceId, chunk)).resolves.toEqual({
      ok: true,
      nextOffset: 3,
    });
    await expect(uploads.execute(deviceId, chunk)).resolves.toEqual({
      ok: true,
      nextOffset: 3,
    });
    await expect(
      uploads.execute(deviceId, { ...chunk, offset: 1 }),
    ).rejects.toMatchObject({ code: "REMOTE_UPLOAD_OFFSET_MISMATCH" });
    await expect(
      uploads.execute(deviceId, {
        command: "file_commit",
        uploadId,
        idempotencyKey: "file-2",
        contentSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "REMOTE_UPLOAD_HASH_MISMATCH" });
    await uploads.close();
  });
});
