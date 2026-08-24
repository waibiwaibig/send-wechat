import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IlinkClient } from "../src/ilink/client.js";
import type { IlinkSendRequest } from "../src/runtime/ports.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

describe("iLink media delivery", () => {
  it("rejects unsafe staged files and upload protocol failures without sending", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "send-wechat-media-errors-"),
    );
    temporaryDirectories.push(directory);
    const stagedPath = join(directory, "staged-file");
    await writeFile(stagedPath, "hello", { mode: 0o600 });
    const request = (
      overrides: Partial<IlinkSendRequest["payload"]> = {},
    ): IlinkSendRequest => ({
      binding: {
        botId: "bot",
        userId: "user",
        baseUrl: "https://ilinkai.weixin.qq.com",
        boundAt: "2026-08-24T00:00:00.000Z",
      },
      secret: { schemaVersion: 1, botToken: "token", contextToken: "context" },
      payload: {
        type: "file",
        stagedPath,
        fileName: "note.txt",
        byteLength: 5,
        ...overrides,
      } as IlinkSendRequest["payload"],
      clientId: "client",
    });
    const noNetwork = new IlinkClient({
      fetch: async () => {
        throw new Error("must not network");
      },
      productVersion: "0.1.0",
    });
    await expect(
      noNetwork.send(request({ fileName: "../unsafe.txt" })),
    ).resolves.toEqual({ status: "failed", code: "INVALID_FILE_NAME" });
    await expect(
      noNetwork.send(request({ stagedPath: join(directory, "missing") })),
    ).resolves.toEqual({ status: "failed", code: "MEDIA_PREPARATION_FAILED" });
    const link = join(directory, "link");
    await symlink(stagedPath, link);
    await expect(
      noNetwork.send(request({ stagedPath: link })),
    ).resolves.toEqual({ status: "failed", code: "INVALID_STAGED_FILE" });
    await expect(noNetwork.send(request({ byteLength: 4 }))).resolves.toEqual({
      status: "failed",
      code: "INVALID_FILE_SIZE",
    });

    for (const uploadResponse of [
      {},
      { ret: -2 },
      { upload_full_url: "http://unsafe.example/upload" },
      { upload_full_url: "https://unsafe.example/upload#hash" },
    ]) {
      const client = new IlinkClient({
        fetch: async (url) =>
          String(url).endsWith("getuploadurl")
            ? jsonResponse(uploadResponse)
            : jsonResponse({ ret: 0 }),
        randomBytes: (size) => Buffer.alloc(size, 4),
        productVersion: "0.1.0",
      });
      const result = await client.send(request());
      expect(result.status).toBe("failed");
      expect([
        "UPLOAD_URL_MISSING",
        "ILINK_RET_-2",
        "UPLOAD_URL_INVALID",
      ]).toContain((result as { code: string }).code);
    }
  });

  it("retries CDN 5xx and malformed successful responses, then cleans encrypted media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-media-retry-"));
    temporaryDirectories.push(directory);
    const stagedPath = join(directory, "staged-file");
    await writeFile(stagedPath, "hello", { mode: 0o600 });
    let attempts = 0;
    const client = new IlinkClient({
      fetch: async (url) => {
        const target = String(url);
        if (target.endsWith("getuploadurl"))
          return jsonResponse({
            upload_full_url: "https://cdn.example/upload",
          });
        if (target === "https://cdn.example/upload") {
          attempts += 1;
          return attempts < 3
            ? new Response(null, { status: 503 })
            : new Response(null, { status: 200 });
        }
        throw new Error("sendmessage must not begin");
      },
      randomBytes: (size) => Buffer.alloc(size, 5),
      sleep: async () => {},
      productVersion: "0.1.0",
    });
    await expect(
      client.send({
        binding: {
          botId: "bot",
          userId: "user",
          baseUrl: "https://ilinkai.weixin.qq.com",
          boundAt: "2026-08-24T00:00:00.000Z",
        },
        secret: {
          schemaVersion: 1,
          botToken: "token",
          contextToken: "context",
        },
        payload: {
          type: "file",
          stagedPath,
          fileName: "note.txt",
          byteLength: 5,
        },
        clientId: "client",
      }),
    ).resolves.toEqual({ status: "failed", code: "CDN_UPLOAD_FAILED" });
    expect(attempts).toBe(3);
    expect((await readdir(directory)).sort()).toEqual(["staged-file"]);
  });

  it("streams, encrypts, uploads, and sends one generic file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-media-test-"));
    temporaryDirectories.push(directory);
    const stagedPath = join(directory, "staged-file");
    await writeFile(stagedPath, "hello", { mode: 0o600 });

    const calls: Array<{ url: string; body: unknown }> = [];
    let encryptedBody = Buffer.alloc(0);
    let sixteenByteCalls = 0;
    const client = new IlinkClient({
      fetch: async (url, init) => {
        const target = String(url);
        calls.push({ url: target, body: init?.body });
        if (target.endsWith("/ilink/bot/getuploadurl")) {
          return jsonResponse({
            upload_full_url: "https://cdn.example/upload",
          });
        }
        if (target === "https://cdn.example/upload") {
          encryptedBody = Buffer.from(
            await new Response(init?.body as BodyInit).arrayBuffer(),
          );
          return new Response(null, {
            status: 200,
            headers: { "x-encrypted-param": "download-parameter" },
          });
        }
        return jsonResponse({ ret: 0 });
      },
      randomBytes: (size) => {
        if (size === 4) return Buffer.alloc(4);
        sixteenByteCalls += 1;
        return Buffer.alloc(16, sixteenByteCalls);
      },
      sleep: async () => {},
      productVersion: "0.1.0",
    });
    const request: IlinkSendRequest = {
      binding: {
        botId: "bot-id",
        userId: "user-id",
        baseUrl: "https://ilinkai.weixin.qq.com",
        boundAt: "2026-08-24T00:00:00.000Z",
      },
      secret: {
        schemaVersion: 1,
        botToken: "bot-token",
        contextToken: "context-token",
      },
      payload: {
        type: "file",
        stagedPath,
        fileName: "note.txt",
        byteLength: 5,
      },
      clientId: "client-file",
    };

    await expect(client.send(request)).resolves.toEqual({
      status: "accepted",
      clientMessageId: "client-file",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl",
      "https://cdn.example/upload",
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
    ]);
    expect(encryptedBody.toString("hex")).toBe(
      "e5f2550ec3d4374b843625e04e51c899",
    );

    const uploadRequest = JSON.parse(String(calls[0]?.body));
    expect(uploadRequest).toMatchObject({
      filekey: "01010101010101010101010101010101",
      media_type: 3,
      to_user_id: "user-id",
      rawsize: 5,
      rawfilemd5: "5d41402abc4b2a76b9719d911017c592",
      filesize: 16,
      no_need_thumb: true,
      aeskey: "02020202020202020202020202020202",
    });

    const sendRequest = JSON.parse(String(calls[2]?.body));
    expect(sendRequest.msg.item_list).toEqual([
      {
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: "download-parameter",
            aes_key: "AgICAgICAgICAgICAgICAg==",
            encrypt_type: 1,
          },
          file_name: "note.txt",
          len: "5",
        },
      },
    ]);
    expect(await readdir(directory)).toEqual(["staged-file"]);
  });

  it("retries CDN server failures but never retries a 4xx", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-media-test-"));
    temporaryDirectories.push(directory);
    const stagedPath = join(directory, "staged-file");
    await writeFile(stagedPath, "hello", { mode: 0o600 });
    let cdnAttempts = 0;
    const client = new IlinkClient({
      fetch: async (url) => {
        const target = String(url);
        if (target.endsWith("/ilink/bot/getuploadurl")) {
          return jsonResponse({
            upload_full_url: "https://cdn.example/upload",
          });
        }
        if (target === "https://cdn.example/upload") {
          cdnAttempts += 1;
          return new Response(null, { status: 403 });
        }
        throw new Error("sendmessage must not begin");
      },
      randomBytes: (size) => Buffer.alloc(size, 3),
      sleep: async () => {},
      productVersion: "0.1.0",
    });

    const result = await client.send({
      binding: {
        botId: "bot-id",
        userId: "user-id",
        baseUrl: "https://ilinkai.weixin.qq.com",
        boundAt: "2026-08-24T00:00:00.000Z",
      },
      secret: {
        schemaVersion: 1,
        botToken: "bot-token",
        contextToken: "context-token",
      },
      payload: {
        type: "file",
        stagedPath,
        fileName: "note.txt",
        byteLength: 5,
      },
      clientId: "client-file",
    });

    expect(result).toEqual({ status: "failed", code: "CDN_UPLOAD_4XX" });
    expect(cdnAttempts).toBe(1);
  });
});
