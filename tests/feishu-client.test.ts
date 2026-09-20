import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuClient,
  type FeishuConfig,
  type FeishuPayload,
} from "../src/feishu/client.js";
import { FeishuCliError, type FeishuCliRunner } from "../src/feishu/cli.js";

const config: FeishuConfig = {
  profile: "send-message",
  receiveIdType: "open_id",
  receiveId: "ou-target",
  ownerOpenId: "ou-owner",
};

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runner(run: FeishuCliRunner["run"]): FeishuCliRunner {
  return {
    run,
    configure: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => ({ close: vi.fn(), isOpen: () => true })),
    removeProfile: vi.fn(async () => undefined),
  };
}

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "feishu-client-test-"));
  roots.push(root);
  await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
  return root;
}

describe("FeishuClient CLI adapter", () => {
  it("rejects invalid targets, client IDs, and media metadata before sending", async () => {
    const root = await stateRoot();
    const run = vi.fn(async () => ({ message_id: "om-never" }));
    const invalidProfile = new FeishuClient(
      { ...config, profile: "" },
      join(root, "state"),
      runner(run),
    );
    await expect(
      invalidProfile.send({ type: "text", text: "hello" }, "client-1"),
    ).resolves.toEqual({ status: "failed", code: "INVALID_PROFILE" });

    const invalidTarget = new FeishuClient(
      { ...config, receiveId: "" },
      join(root, "state"),
      runner(run),
    );
    await expect(
      invalidTarget.send({ type: "text", text: "hello" }, "client-1"),
    ).resolves.toEqual({ status: "failed", code: "INVALID_TARGET" });

    const client = new FeishuClient(config, join(root, "state"), runner(run));
    await expect(
      client.send({ type: "text", text: "hello" }, ""),
    ).resolves.toEqual({ status: "rejected", code: "INVALID_CLIENT_ID" });

    const mediaCases: Array<{
      payload: FeishuPayload;
      code: string;
    }> = [
      {
        payload: {
          type: "file",
          stagedPath: "",
          fileName: "file.txt",
          byteLength: 1,
        },
        code: "INVALID_MEDIA",
      },
      {
        payload: {
          type: "file",
          stagedPath: "/tmp/missing",
          fileName: "../file.txt",
          byteLength: 1,
        },
        code: "INVALID_MEDIA",
      },
      {
        payload: {
          type: "file",
          stagedPath: "/tmp/missing",
          fileName: "file.txt",
          byteLength: 0,
        },
        code: "INVALID_MEDIA_SIZE",
      },
      {
        payload: {
          type: "image",
          stagedPath: "/tmp/missing",
          fileName: "image.png",
          byteLength: 10 * 1024 * 1024 + 1,
        },
        code: "IMAGE_TOO_LARGE",
      },
      {
        payload: {
          type: "file",
          stagedPath: "/tmp/missing",
          fileName: "file.bin",
          byteLength: 30 * 1024 * 1024 + 1,
        },
        code: "FILE_TOO_LARGE",
      },
      {
        payload: {
          type: "video",
          stagedPath: "",
          fileName: "video.mp4",
          byteLength: 1,
        } as unknown as FeishuPayload,
        code: "INVALID_MEDIA",
      },
    ];
    for (const { payload, code } of mediaCases)
      await expect(client.send(payload, "media")).resolves.toEqual({
        status: "rejected",
        code,
      });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects staged size mismatches, directories, and non-image image payloads", async () => {
    const root = await stateRoot();
    const source = join(root, "source.txt");
    await writeFile(source, "plain text");
    const directory = join(root, "directory");
    await mkdir(directory);
    const run = vi.fn(async () => ({ message_id: "om-never" }));
    const client = new FeishuClient(config, join(root, "state"), runner(run));

    await expect(
      client.send(
        {
          type: "file",
          stagedPath: source,
          fileName: "file.txt",
          byteLength: 1,
        },
        "mismatch",
      ),
    ).resolves.toEqual({ status: "rejected", code: "MEDIA_SIZE_MISMATCH" });
    await expect(
      client.send(
        {
          type: "file",
          stagedPath: directory,
          fileName: "file.txt",
          byteLength: 1,
        },
        "directory",
      ),
    ).resolves.toEqual({ status: "failed", code: "STAGED_FILE_UNREADABLE" });
    await expect(
      client.send(
        {
          type: "image",
          stagedPath: source,
          fileName: "image.png",
          byteLength: Buffer.byteLength("plain text"),
        },
        "invalid-image",
      ),
    ).resolves.toEqual({ status: "failed", code: "INVALID_IMAGE" });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps server 5xx and malformed sends, and preserves verify failure codes", async () => {
    const run = vi
      .fn<FeishuCliRunner["run"]>()
      .mockRejectedValueOnce(new FeishuCliError("FEISHU_500"))
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new FeishuCliError("FEISHU_AUTH"))
      .mockRejectedValueOnce(new Error("network app_secret"));
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      runner(run),
    );

    await expect(
      client.send({ type: "text", text: "hello" }, "server-5xx"),
    ).resolves.toEqual({ status: "unknown", code: "FEISHU_500" });
    await expect(
      client.send({ type: "text", text: "hello" }, "malformed"),
    ).resolves.toEqual({ status: "unknown", code: "MALFORMED_SEND_RESPONSE" });
    await expect(client.verify()).rejects.toMatchObject({
      code: "FEISHU_AUTH",
    });
    const verifyError = await client.verify().catch((error: unknown) => error);
    expect(verifyError).toMatchObject({ code: "VERIFY_NETWORK_ERROR" });
    expect(String(verifyError)).not.toContain("app_secret");
  });

  it("sends text with a fixed recipient and idempotency key", async () => {
    const run = vi.fn(async () => ({ message_id: "om-sent" }));
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      runner(run),
    );

    await expect(
      client.send({ type: "text", text: "hello" }, "client-1"),
    ).resolves.toEqual({
      status: "accepted",
      clientMessageId: "om-sent",
    });
    expect(run).toHaveBeenCalledWith(
      [
        "im",
        "+messages-send",
        "--user-id",
        "ou-target",
        "--text",
        "hello",
        "--idempotency-key",
        "client-1",
      ],
      {},
    );
  });

  it("keeps API rejection distinct from uncertain subprocess results", async () => {
    const run = vi
      .fn<FeishuCliRunner["run"]>()
      .mockRejectedValueOnce(new FeishuCliError("FEISHU_230001"))
      .mockRejectedValueOnce(new FeishuCliError("CLI_TIMEOUT"));
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      runner(run),
    );

    await expect(
      client.send({ type: "text", text: "hello" }, "reject"),
    ).resolves.toEqual({
      status: "rejected",
      code: "FEISHU_230001",
    });
    await expect(
      client.send({ type: "text", text: "hello" }, "unknown"),
    ).resolves.toEqual({
      status: "unknown",
      code: "CLI_TIMEOUT",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stages media under a private cwd and preserves the supplied filename", async () => {
    const root = await stateRoot();
    const source = join(root, "source.png");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(source, image);
    let stagedPath = "";
    const run = vi.fn(async (args: string[], options?: { cwd?: string }) => {
      if (args.includes("--image"))
        stagedPath = join(options?.cwd ?? "", "photo.png");
      return { message_id: "om-image" };
    });
    const client = new FeishuClient(config, join(root, "state"), runner(run));
    const payload: FeishuPayload = {
      type: "image",
      stagedPath: source,
      fileName: "photo.png",
      byteLength: image.length,
    };

    await expect(client.send(payload, "image-1")).resolves.toEqual({
      status: "accepted",
      clientMessageId: "om-image",
    });
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "--image",
        "./photo.png",
        "--idempotency-key",
        "image-1",
      ]),
      expect.objectContaining({
        cwd: expect.stringContaining("feishu-staging-"),
      }),
    );
    await expect(stat(stagedPath)).rejects.toThrow();
  });

  it("filters owner and target before reading raw media content", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "api")
        return {
          data: {
            items: [
              {
                body: {
                  content: JSON.stringify({
                    file_key: "file-1",
                    file_name: "a.pdf",
                  }),
                },
              },
            ],
          },
        };
      return undefined;
    });
    let handler: ((event: unknown) => Promise<void>) | undefined;
    const cli = {
      ...runner(run),
      subscribe: async (callback: (event: unknown) => Promise<void>) => {
        handler = callback;
        return { close: vi.fn(), isOpen: () => true };
      },
    } as FeishuCliRunner;
    const callback = vi.fn();
    const client = new FeishuClient(
      { ...config, receiveIdType: "chat_id", receiveId: "oc-group" },
      join(await stateRoot(), "state"),
      cli,
    );
    await client.startReceiving(callback);
    await handler?.({
      type: "im.message.receive_v1",
      sender_type: "user",
      sender_id: "ou-other",
      chat_type: "group",
      chat_id: "oc-group",
      message_id: "om_ignore",
      message_type: "file",
    });
    expect(run).not.toHaveBeenCalled();
    await handler?.({
      type: "im.message.receive_v1",
      sender_type: "user",
      sender_id: "ou-owner",
      chat_type: "group",
      chat_id: "oc-group",
      message_id: "om_file",
      message_type: "file",
      create_time: "10",
      content: "rendered file",
    });
    expect(run).toHaveBeenCalledWith([
      "api",
      "GET",
      "/open-apis/im/v1/messages/om_file",
    ]);
    expect(callback).toHaveBeenCalledWith({
      id: "om_file",
      text: "",
      receivedAt: 10,
      attachments: [{ type: "file", key: "file-1", fileName: "a.pdf" }],
    });
  });

  it("filters malformed, bot, owner, chat, and message types before invoking the callback", async () => {
    let handler: ((event: unknown) => Promise<void>) | undefined;
    const subscribe = vi.fn(
      async (callback: (event: unknown) => Promise<void>) => {
        handler = callback;
        return { close: vi.fn(), isOpen: () => true };
      },
    );
    const cli = {
      ...runner(vi.fn(async () => undefined)),
      subscribe,
    } as FeishuCliRunner;
    const callback = vi.fn();
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      cli,
    );
    await client.startReceiving(callback);

    const invalidEvents: unknown[] = [
      null,
      {},
      { type: "other", sender_type: "user" },
      {
        type: "im.message.receive_v1",
        sender_type: "bot",
        sender_id: "ou-owner",
        chat_type: "p2p",
        message_id: "om-bot",
        message_type: "text",
        content: "ignore",
      },
      {
        type: "im.message.receive_v1",
        sender_type: "user",
        sender_id: "ou-other",
        chat_type: "p2p",
        message_id: "om-owner",
        message_type: "text",
        content: "ignore",
      },
      {
        type: "im.message.receive_v1",
        sender_type: "user",
        sender_id: "ou-owner",
        chat_type: "group",
        message_id: "om-group",
        message_type: "text",
        content: "ignore",
      },
      {
        type: "im.message.receive_v1",
        sender_type: "user",
        sender_id: "ou-owner",
        chat_type: "p2p",
        message_id: "message-without-prefix",
        message_type: "text",
        content: "ignore",
      },
      {
        type: "im.message.receive_v1",
        sender_type: "user",
        sender_id: "ou-owner",
        chat_type: "p2p",
        message_id: "om-sticker",
        message_type: "sticker",
      },
      {
        type: "im.message.receive_v1",
        sender_type: "user",
        sender_id: "ou-owner",
        chat_type: "p2p",
        message_id: "om-no-content",
        message_type: "text",
      },
    ];
    for (const event of invalidEvents) await handler?.(event);
    expect(callback).not.toHaveBeenCalled();

    const now = vi.spyOn(Date, "now").mockReturnValue(42);
    await handler?.({
      type: "im.message.receive_v1",
      sender_type: "user",
      sender_id: "ou-owner",
      chat_type: "p2p",
      message_id: "om_valid",
      message_type: "text",
      content: "accepted",
      create_time: "invalid",
    });
    expect(callback).toHaveBeenCalledWith({
      id: "om_valid",
      text: "accepted",
      receivedAt: 42,
      attachments: [],
    });
    now.mockRestore();
  });

  it("returns defaults for malformed attachment responses and image names", async () => {
    const run = vi
      .fn<FeishuCliRunner["run"]>()
      .mockResolvedValueOnce({ body: { content: "not json" } })
      .mockResolvedValueOnce({
        data: {
          item: {
            body: {
              content: JSON.stringify({ image_key: "img-1" }),
            },
          },
        },
      });
    let handler: ((event: unknown) => Promise<void>) | undefined;
    const cli = {
      ...runner(run),
      subscribe: async (callback: (event: unknown) => Promise<void>) => {
        handler = callback;
        return { close: vi.fn(), isOpen: () => true };
      },
    } as FeishuCliRunner;
    const callback = vi.fn();
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      cli,
    );
    await client.startReceiving(callback);
    const event = {
      type: "im.message.receive_v1",
      sender_type: "user",
      sender_id: "ou-owner",
      chat_type: "p2p",
      message_id: "om_file",
      message_type: "file",
      create_time: "10",
    };
    await handler?.(event);
    expect(callback).not.toHaveBeenCalled();
    await handler?.({
      ...event,
      message_id: "om_image",
      message_type: "image",
    });
    expect(callback).toHaveBeenCalledWith({
      id: "om_image",
      text: "",
      receivedAt: 10,
      attachments: [{ type: "image", key: "img-1", fileName: "image" }],
    });
  });

  it("downloads through a private temporary path and refuses overwrite", async () => {
    const root = await stateRoot();
    const destination = join(root, "chosen.bin");
    const run = vi.fn(async (_args: string[], options?: { cwd?: string }) => {
      await writeFile(join(options?.cwd ?? "", "resource.bin"), "resource");
      return { saved_path: "resource", size_bytes: 8 };
    });
    const client = new FeishuClient(config, join(root, "state"), runner(run));
    await client.downloadResource(
      "om-message",
      "file-key",
      "file",
      destination,
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("resource");
    await expect(
      client.downloadResource("om-message", "file-key", "file", destination),
    ).rejects.toThrow();
  });

  it("rejects invalid resource arguments and cleans oversized downloads", async () => {
    const root = await stateRoot();
    const run = vi.fn<FeishuCliRunner["run"]>();
    const client = new FeishuClient(config, join(root, "state"), runner(run));
    await expect(
      client.downloadResource("", "key", "file", join(root, "out.bin")),
    ).rejects.toThrow("INVALID_MESSAGE_ID");
    await expect(
      client.downloadResource("message", "", "file", join(root, "out.bin")),
    ).rejects.toThrow("INVALID_RESOURCE_KEY");
    await expect(
      client.downloadResource("message", "key", "file", ""),
    ).rejects.toThrow("INVALID_DESTINATION");

    run.mockImplementation(async (_args, options) => {
      const output = join(options?.cwd ?? "", "resource.bin");
      await writeFile(output, "x");
      await truncate(output, 100 * 1024 * 1024 + 1);
      return undefined;
    });
    await expect(
      client.downloadResource("message", "key", "file", join(root, "out.bin")),
    ).rejects.toThrow("RESOURCE_TOO_LARGE");
    expect(await readdir(join(root, "state"))).toEqual([]);
  });

  it("restarts a stale subscription and closes it explicitly", async () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    let open = true;
    const subscribe = vi
      .fn()
      .mockResolvedValueOnce({ close: firstClose, isOpen: () => open })
      .mockResolvedValueOnce({ close: secondClose, isOpen: () => true });
    const cli = {
      ...runner(vi.fn(async () => undefined)),
      subscribe,
    } as FeishuCliRunner;
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      cli,
    );
    await client.startReceiving(vi.fn());
    open = false;
    expect(client.isReceiving()).toBe(false);
    await client.startReceiving(vi.fn());
    expect(firstClose).toHaveBeenCalledOnce();
    client.close();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("does not duplicate an active subscription and reports closed state", async () => {
    const close = vi.fn();
    const subscribe = vi.fn().mockResolvedValue({ close, isOpen: () => true });
    const cli = {
      ...runner(vi.fn(async () => undefined)),
      subscribe,
    } as FeishuCliRunner;
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      cli,
    );

    await client.startReceiving(vi.fn());
    await client.startReceiving(vi.fn());
    expect(subscribe).toHaveBeenCalledOnce();
    expect(client.isReceiving()).toBe(true);
    client.close();
    expect(close).toHaveBeenCalledOnce();
    expect(client.isReceiving()).toBe(false);
  });

  it("clears a failed subscription so the next start can retry", async () => {
    const failure = new Error("stream unavailable");
    const close = vi.fn();
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ close, isOpen: () => true });
    const cli = {
      ...runner(vi.fn(async () => undefined)),
      subscribe,
    } as FeishuCliRunner;
    const client = new FeishuClient(
      config,
      join(await stateRoot(), "state"),
      cli,
    );

    await expect(client.startReceiving(vi.fn())).rejects.toBe(failure);
    expect(client.isReceiving()).toBe(false);
    await client.startReceiving(vi.fn());
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(client.isReceiving()).toBe(true);
    client.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
