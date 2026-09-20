import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuClient, type FeishuSdkFactory } from "../src/feishu/client.js";

const credentials = { appId: "app-id", appSecret: "app-secret" };
const target = {
  receiveIdType: "open_id" as const,
  receiveId: "ou-target",
  ownerOpenId: "ou-owner",
};

type Api = {
  request: ReturnType<typeof vi.fn>;
  im: {
    image: { create: ReturnType<typeof vi.fn> };
    file: { create: ReturnType<typeof vi.fn> };
    message: { create: ReturnType<typeof vi.fn> };
    messageResource: { get: ReturnType<typeof vi.fn> };
  };
};

let dispatcherHandler: ((event: unknown) => unknown) | undefined;
let wsInstance:
  | { start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  | undefined;

function sdkFor(api: Api): FeishuSdkFactory {
  class Client {
    public readonly request = api.request;
    public readonly im = api.im;

    public constructor(_params: {
      appId: string;
      appSecret: string;
      logger?: unknown;
    }) {
      void _params;
    }
  }
  class EventDispatcher {
    public register(
      handles: Record<string, (event: unknown) => unknown>,
    ): this {
      dispatcherHandler = handles["im.message.receive_v1"];
      return this;
    }
  }
  class WSClient {
    public readonly start = vi.fn(async () => undefined);
    public readonly close = vi.fn();

    public constructor(_params: {
      appId: string;
      appSecret: string;
      autoReconnect?: boolean;
      logger?: unknown;
    }) {
      void _params;
      wsInstance = { start: this.start, close: this.close };
    }
  }
  return { Client, EventDispatcher, WSClient } as unknown as FeishuSdkFactory;
}

function apiFor(): Api {
  return {
    request: vi.fn(async () => ({ code: 0, data: {} })),
    im: {
      image: { create: vi.fn(async () => ({ image_key: "img-key" })) },
      file: { create: vi.fn(async () => ({ file_key: "file-key" })) },
      message: {
        create: vi.fn(async () => ({
          code: 0,
          data: { message_id: "msg-id" },
        })),
      },
      messageResource: {
        get: vi.fn(async () => ({
          getReadableStream: () => Readable.from([Buffer.from("resource")]),
        })),
      },
    },
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  dispatcherHandler = undefined;
  wsInstance = undefined;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("FeishuClient outbound API", () => {
  it("sends text to the fixed target with clientId as uuid", async () => {
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));

    await expect(
      client.send({ type: "text", text: "hello" }, "client-1"),
    ).resolves.toEqual({
      status: "accepted",
      clientMessageId: "msg-id",
    });
    expect(api.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: "ou-target",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
        uuid: "client-1",
      },
    });
  });

  it("classifies API rejection and transport uncertainty without retrying", async () => {
    const api = apiFor();
    api.im.message.create.mockResolvedValueOnce({
      code: 230001,
      msg: "private detail",
    });
    const client = new FeishuClient(credentials, target, sdkFor(api));
    await expect(
      client.send({ type: "text", text: "hello" }, "client-2"),
    ).resolves.toEqual({
      status: "rejected",
      code: "FEISHU_230001",
    });

    api.im.message.create.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      client.send({ type: "text", text: "hello" }, "client-3"),
    ).resolves.toEqual({
      status: "unknown",
      code: "NETWORK_RESULT_UNKNOWN",
    });
    expect(api.im.message.create).toHaveBeenCalledTimes(2);
  });

  it("uploads image and file before sending, and enforces payload limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const imagePath = join(root, "image.bin");
    const filePath = join(root, "report.bin");
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(imagePath, imageBytes);
    await writeFile(filePath, Buffer.from("file"));
    const api = apiFor();
    const client = new FeishuClient(
      credentials,
      { ...target, receiveIdType: "chat_id", receiveId: "oc-group" },
      sdkFor(api),
    );

    await expect(
      client.send(
        {
          type: "image",
          stagedPath: imagePath,
          fileName: "image.png",
          byteLength: imageBytes.length,
        },
        "img-1",
      ),
    ).resolves.toEqual({
      status: "accepted",
      clientMessageId: "msg-id",
    });
    await expect(
      client.send(
        {
          type: "file",
          stagedPath: filePath,
          fileName: "report.pdf",
          byteLength: 4,
        },
        "file-1",
      ),
    ).resolves.toEqual({
      status: "accepted",
      clientMessageId: "msg-id",
    });
    expect(api.im.image.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ image_type: "message" }),
    });
    expect(api.im.file.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        file_type: "stream",
        file_name: "report.pdf",
      }),
    });
    expect(api.im.message.create).toHaveBeenCalledTimes(2);

    await expect(
      client.send({ type: "text", text: "x".repeat(4001) }, "too-long"),
    ).resolves.toEqual({
      status: "rejected",
      code: "TEXT_TOO_LONG",
    });
    await expect(
      client.send(
        {
          type: "image",
          stagedPath: imagePath,
          fileName: "x",
          byteLength: 10 * 1024 * 1024 + 1,
        },
        "too-large",
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "IMAGE_TOO_LARGE",
    });
  });

  it("rejects empty text and counts Unicode code points for the text limit", async () => {
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));

    await expect(
      client.send({ type: "text", text: "" }, "empty-text"),
    ).resolves.toEqual({ status: "rejected", code: "EMPTY_TEXT" });
    await expect(
      client.send({ type: "text", text: "🙂".repeat(4001) }, "unicode-long"),
    ).resolves.toEqual({ status: "rejected", code: "TEXT_TOO_LONG" });
    expect(api.im.message.create).not.toHaveBeenCalled();
  });

  it("rejects media whose declared size differs from the staged file", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const filePath = join(root, "report.bin");
    await writeFile(filePath, Buffer.from("file"));
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));

    await expect(
      client.send(
        {
          type: "file",
          stagedPath: filePath,
          fileName: "report",
          byteLength: 3,
        },
        "size-mismatch",
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "MEDIA_SIZE_MISMATCH",
    });
    expect(api.im.file.create).not.toHaveBeenCalled();
  });

  it("rejects an image whose bytes are not an image type", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const imagePath = join(root, "invalid-image.bin");
    await writeFile(imagePath, Buffer.from("plain text"));
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));

    await expect(
      client.send(
        {
          type: "image",
          stagedPath: imagePath,
          fileName: "image.png",
          byteLength: 10,
        },
        "invalid-image",
      ),
    ).resolves.toEqual({ status: "failed", code: "INVALID_IMAGE" });
    expect(api.im.image.create).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink media without uploading the link target",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
      tempDirs.push(root);
      const targetPath = join(root, "target.bin");
      const linkPath = join(root, "link.bin");
      await writeFile(targetPath, Buffer.from("file"));
      await symlink(targetPath, linkPath);
      const api = apiFor();
      const client = new FeishuClient(credentials, target, sdkFor(api));

      await expect(
        client.send(
          {
            type: "file",
            stagedPath: linkPath,
            fileName: "link",
            byteLength: 4,
          },
          "symlink-media",
        ),
      ).resolves.toEqual({
        status: "failed",
        code: "STAGED_FILE_UNREADABLE",
      });
      expect(api.im.file.create).not.toHaveBeenCalled();
    },
  );

  it("classifies upload failures and explicit upload rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const path = join(root, "file.bin");
    await writeFile(path, Buffer.from("x"));
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));
    api.im.file.create.mockRejectedValueOnce(new Error("upload transport"));
    await expect(
      client.send(
        { type: "file", stagedPath: path, fileName: "x", byteLength: 1 },
        "failed-upload",
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "UPLOAD_FAILED",
    });
    api.im.file.create.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { code: 230002 }),
    );
    await expect(
      client.send(
        { type: "file", stagedPath: path, fileName: "x", byteLength: 1 },
        "rejected-upload",
      ),
    ).resolves.toEqual({
      status: "rejected",
      code: "FEISHU_230002",
    });
    expect(api.im.file.create).toHaveBeenCalledTimes(2);
    expect(api.im.message.create).not.toHaveBeenCalled();
  });

  it("does not send after malformed upload or message responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const filePath = join(root, "file.bin");
    await writeFile(filePath, Buffer.from("x"));
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));

    api.im.file.create.mockResolvedValueOnce({ code: 0 });
    await expect(
      client.send(
        { type: "file", stagedPath: filePath, fileName: "x", byteLength: 1 },
        "malformed-upload",
      ),
    ).resolves.toEqual({
      status: "failed",
      code: "MALFORMED_UPLOAD_RESPONSE",
    });
    expect(api.im.file.create).toHaveBeenCalledOnce();
    expect(api.im.message.create).not.toHaveBeenCalled();

    api.im.message.create.mockResolvedValueOnce({ code: 0, data: {} });
    await expect(
      client.send({ type: "text", text: "hello" }, "malformed-send"),
    ).resolves.toEqual({
      status: "unknown",
      code: "MALFORMED_SEND_RESPONSE",
    });
    expect(api.im.message.create).toHaveBeenCalledOnce();
  });
});

describe("FeishuClient receiving and resources", () => {
  it("verifies credentials through the read-only bot identity endpoint", async () => {
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));
    await expect(client.verify()).resolves.toBeUndefined();
    expect(api.request).toHaveBeenCalledWith({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    });

    api.request.mockResolvedValueOnce({ code: 999001 });
    await expect(client.verify()).rejects.toMatchObject({
      code: "FEISHU_999001",
    });
  });

  it("filters inbound events by owner and exact group target", async () => {
    const api = apiFor();
    const callback = vi.fn();
    const client = new FeishuClient(
      credentials,
      { ...target, receiveIdType: "chat_id", receiveId: "oc-group" },
      sdkFor(api),
    );
    await client.startReceiving(callback);
    expect(wsInstance?.start).toHaveBeenCalledOnce();
    expect(dispatcherHandler).toBeDefined();

    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-other" } },
      message: {
        message_id: "ignored",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "no" }),
        create_time: "1",
      },
    });
    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-owner" } },
      message: {
        message_id: "wrong-chat",
        chat_id: "oc-other",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "no" }),
        create_time: "1",
      },
    });
    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-owner" } },
      message: {
        message_id: "accepted",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "yes" }),
        create_time: "1",
      },
    });
    expect(callback).toHaveBeenCalledWith({
      id: "accepted",
      text: "yes",
      receivedAt: 1,
      attachments: [],
    });

    client.close();
    expect(wsInstance?.close).toHaveBeenCalledWith({ force: true });
  });

  it("accepts the owner in a fixed p2p target and rejects unsupported or malformed content", async () => {
    const api = apiFor();
    const callback = vi.fn();
    const client = new FeishuClient(credentials, target, sdkFor(api));
    await client.startReceiving(callback);

    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-owner" } },
      message: {
        message_id: "p2p-text",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "accepted" }),
        create_time: "2",
      },
    });
    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-owner" } },
      message: {
        message_id: "audio",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({ file_key: "ignored" }),
        create_time: "3",
      },
    });
    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-owner" } },
      message: {
        message_id: "malformed",
        chat_type: "p2p",
        message_type: "text",
        content: "{malformed",
        create_time: "4",
      },
    });
    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-owner" } },
      message: {
        message_id: "image",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "image-key" }),
        create_time: "5",
      },
    });
    await dispatcherHandler?.({
      sender: { sender_id: { open_id: "ou-owner" } },
      message: {
        message_id: "file",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file-key", file_name: "a.pdf" }),
        create_time: "6",
      },
    });

    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenNthCalledWith(1, {
      id: "p2p-text",
      text: "accepted",
      receivedAt: 2,
      attachments: [],
    });
    expect(callback).toHaveBeenNthCalledWith(2, {
      id: "image",
      text: "",
      receivedAt: 5,
      attachments: [{ type: "image", key: "image-key", fileName: "image" }],
    });
    expect(callback).toHaveBeenNthCalledWith(3, {
      id: "file",
      text: "",
      receivedAt: 6,
      attachments: [{ type: "file", key: "file-key", fileName: "a.pdf" }],
    });
  });

  it("downloads message resources as a bounded stream using the caller path", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const destination = join(root, "chosen-name.bin");
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));
    await client.downloadResource(
      "om-message",
      "file-key",
      "file",
      destination,
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("resource");
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    }
    expect(api.im.messageResource.get).toHaveBeenCalledWith({
      params: { type: "file" },
      path: { message_id: "om-message", file_key: "file-key" },
    });
  });

  it("does not overwrite an existing destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const destination = join(root, "existing.bin");
    await writeFile(destination, "keep");
    const api = apiFor();
    const client = new FeishuClient(credentials, target, sdkFor(api));

    await expect(
      client.downloadResource("om-message", "file-key", "file", destination),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(destination, "utf8")).resolves.toBe("keep");
  });

  it("cleans a newly created destination when the resource stream fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-client-"));
    tempDirs.push(root);
    const destination = join(root, "failed.bin");
    const api = apiFor();
    api.im.messageResource.get.mockResolvedValueOnce({
      getReadableStream: () =>
        Readable.from(
          (async function* () {
            yield Buffer.from("partial");
            throw new Error("resource failed");
          })(),
        ),
    });
    const client = new FeishuClient(credentials, target, sdkFor(api));

    await expect(
      client.downloadResource("om-message", "file-key", "file", destination),
    ).rejects.toThrow("resource failed");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
