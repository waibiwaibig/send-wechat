import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuClient, type FeishuClientCli } from "../src/feishu/client.js";
import { FeishuCliError, type FeishuCliRunner } from "../src/feishu/cli.js";
import { FeishuReceiver } from "../src/feishu/receiver.js";
import { FeishuRuntime } from "../src/feishu/runtime.js";
import {
  FeishuConfigurationStore,
  type FeishuConfiguration,
} from "../src/messaging/config.js";
import { AttachmentStore } from "../src/messaging/attachments.js";
import { SqliteTextInbox } from "../src/messaging/text-inbox.js";
import { SqliteIdempotencyStore } from "../src/storage/idempotency-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type FakeCli = FeishuClientCli & {
  run: ReturnType<typeof vi.fn<FeishuCliRunner["run"]>>;
};

function configuration(): FeishuConfiguration {
  return {
    profile: "send-message",
    receiveIdType: "open_id",
    receiveId: "ou_owner",
    ownerOpenId: "ou_owner",
    dmChatId: "oc_owner-dm",
  };
}

function fakeCli(runImplementation?: FeishuCliRunner["run"]): {
  cli: FakeCli;
  emit(event: unknown): Promise<void>;
} {
  let receiving = false;
  let callback: ((event: unknown) => void | Promise<void>) | null = null;
  const run = vi.fn<FeishuCliRunner["run"]>();
  if (runImplementation !== undefined)
    run.mockImplementation(runImplementation);
  const subscribe = vi
    .fn<FeishuCliRunner["subscribe"]>()
    .mockImplementation(async (handler) => {
      callback = handler;
      receiving = true;
      return {
        close: () => {
          receiving = false;
        },
        isOpen: () => receiving,
      };
    });
  const cli = { run, subscribe } as FakeCli;
  return {
    cli,
    emit: async (event) => {
      await callback?.(event);
    },
  };
}

async function savedConfiguration(root: string): Promise<FeishuConfiguration> {
  const store = new FeishuConfigurationStore(root);
  await store.save(configuration());
  const loaded = await store.load();
  expect(loaded).toEqual(configuration());
  if (loaded === null) throw new Error("configuration fixture did not reload");
  return loaded;
}

function event(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "im.message.receive_v1",
    sender_type: "user",
    sender_id: "ou_owner",
    chat_type: "p2p",
    chat_id: "oc_owner-dm",
    message_id: "om_message",
    message_type: "text",
    create_time: "1700000000000",
    content: "1",
    ...overrides,
  };
}

describe("Feishu conversation integration", () => {
  it("filters inbound events, stores authorized text, and replies through the bound DM chat", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "send-message-feishu-conversation-"),
    );
    directories.push(root);
    const config = await savedConfiguration(root);
    const fake = fakeCli(async (args) => {
      if (args[0] === "im" && args[1] === "+messages-send")
        return { message_id: "om_reply" };
      throw new Error("unexpected CLI call in text integration");
    });
    const client = new FeishuClient(config, join(root, "client"), fake.cli);
    const inbox = new SqliteTextInbox(join(root, "inbox.sqlite"));
    const receiver = new FeishuReceiver(
      client,
      inbox,
      new AttachmentStore(join(root, "attachments")),
    );
    inbox.poll("conversation-consumer");
    await receiver.tick();
    expect(receiver.diagnostics().listener).toBe("listening");

    await fake.emit(
      event({ sender_id: "ou_other", message_id: "om_wrong-owner" }),
    );
    await fake.emit(
      event({
        chat_type: "group",
        chat_id: "oc_group",
        message_id: "om_group",
      }),
    );
    await fake.emit(
      event({ chat_id: "oc_other-dm", message_id: "om_wrong-dm" }),
    );
    expect(inbox.poll("conversation-consumer").messages).toEqual([]);

    const receivedAt = Date.now();
    await fake.emit(
      event({ message_id: "om_authorized", create_time: String(receivedAt) }),
    );
    const inbound = inbox.poll("conversation-consumer");
    expect(inbound.messages).toEqual([
      {
        id: "om_authorized",
        text: "1",
        receivedAt,
      },
    ]);
    inbox.ack(
      "conversation-consumer",
      inbound.messages.map((message) => message.id),
    );

    const simulatedModelResponse = "stub model response";
    const runtime = new FeishuRuntime(
      client,
      new SqliteIdempotencyStore(join(root, "text-ledger.sqlite")),
    );
    const textCommand = {
      type: "send-text" as const,
      requestId: "request-text",
      idempotencyKey: "reply-text-1",
      text: simulatedModelResponse,
    };
    await expect(runtime.execute(textCommand)).resolves.toMatchObject({
      ok: true,
      result: { state: "accepted", deduplicated: false },
    });
    await expect(
      runtime.execute({ ...textCommand, requestId: "request-text-retry" }),
    ).resolves.toMatchObject({
      ok: true,
      result: { state: "accepted", deduplicated: true },
    });
    expect(fake.cli.run).toHaveBeenCalledTimes(1);
    expect(fake.cli.run).toHaveBeenCalledWith(
      [
        "im",
        "+messages-send",
        "--chat-id",
        "oc_owner-dm",
        "--text",
        simulatedModelResponse,
        "--idempotency-key",
        expect.any(String),
      ],
      {},
    );
    await receiver.close();
    inbox.close();
  });

  it("uploads a staged markdown file once and keeps an unknown submit terminal after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-message-feishu-file-"));
    directories.push(root);
    const config = await savedConfiguration(root);
    await mkdir(join(root, "client"), { recursive: true, mode: 0o700 });
    const content = Buffer.from("# issue\n");
    const stagedPath = join(root, "issue.md");
    await writeFile(stagedPath, content, { mode: 0o600 });
    const fake = fakeCli(async (args) => {
      if (args[0] === "im" && args[1] === "files")
        return { file_key: "file_md_123" };
      if (args[0] === "im" && args[1] === "+messages-send")
        throw new FeishuCliError("CLI_TIMEOUT");
      throw new Error("unexpected CLI call in file integration");
    });
    const client = new FeishuClient(config, join(root, "client"), fake.cli);
    const ledgerPath = join(root, "file-ledger.sqlite");
    const command = {
      type: "send-file" as const,
      requestId: "request-file",
      idempotencyKey: "reply-file-1",
      stagedPath,
      fileName: "issue.md",
      byteLength: content.byteLength,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      mediaKind: "file" as const,
    };
    const runtime = new FeishuRuntime(
      client,
      new SqliteIdempotencyStore(ledgerPath),
    );
    await expect(runtime.execute(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "RESULT_UNKNOWN", causeCode: "SEND_CLI_TIMEOUT" },
    });
    expect(fake.cli.run).toHaveBeenCalledTimes(2);
    expect(fake.cli.run.mock.calls[0]?.[0]).toEqual([
      "im",
      "files",
      "create",
      "--data",
      JSON.stringify({ file_type: "stream", file_name: "issue.md" }),
      "--file",
      "file=./issue.md",
    ]);
    expect(fake.cli.run.mock.calls[1]?.[0]).toEqual([
      "im",
      "+messages-send",
      "--chat-id",
      "oc_owner-dm",
      "--file",
      "file_md_123",
      "--idempotency-key",
      expect.any(String),
    ]);

    const reopened = new FeishuRuntime(
      new FeishuClient(config, join(root, "client-reopened"), fake.cli),
      new SqliteIdempotencyStore(ledgerPath),
    );
    await expect(
      reopened.execute({ ...command, requestId: "request-file-retry" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RESULT_UNKNOWN", causeCode: "SEND_CLI_TIMEOUT" },
    });
    expect(fake.cli.run).toHaveBeenCalledTimes(2);
  });
});
