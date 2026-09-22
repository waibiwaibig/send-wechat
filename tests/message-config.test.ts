import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MessageConfigStore,
  FeishuConfigurationStore,
  feishuConfigurationSchema,
  messageConfigSchema,
} from "../src/messaging/config.js";
import type { FeishuConfiguration } from "../src/messaging/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function validFeishu(
  overrides: Partial<FeishuConfiguration> = {},
): FeishuConfiguration {
  return {
    profile: "send-message",
    receiveIdType: "open_id",
    receiveId: "ou_owner123",
    ownerOpenId: "ou_owner123",
    dmChatId: "oc_chat123",
    ...overrides,
  };
}

describe("message configuration schemas", () => {
  it("requires the default channel to be enabled exactly once", () => {
    expect(() =>
      messageConfigSchema.parse({
        schemaVersion: 1,
        defaultChannel: "feishu",
        channels: ["wechat"],
      }),
    ).toThrow();
    expect(() =>
      messageConfigSchema.parse({
        schemaVersion: 1,
        defaultChannel: "wechat",
        channels: ["wechat", "wechat"],
      }),
    ).toThrow();
    expect(
      messageConfigSchema.parse({
        schemaVersion: 1,
        defaultChannel: "feishu",
        channels: ["wechat", "feishu"],
      }),
    ).toEqual({
      schemaVersion: 1,
      defaultChannel: "feishu",
      channels: ["wechat", "feishu"] as ["wechat", "feishu"],
    });
  });

  it("requires a Feishu direct message target to equal the owner", () => {
    expect(() =>
      feishuConfigurationSchema.parse(
        validFeishu({ receiveId: "ou_other123" }),
      ),
    ).toThrow();
    expect(feishuConfigurationSchema.parse(validFeishu())).toMatchObject({
      receiveIdType: "open_id",
      receiveId: "ou_owner123",
      dmChatId: "oc_chat123",
    });
    expect(() =>
      feishuConfigurationSchema.parse(
        validFeishu({ dmChatId: undefined } as Partial<FeishuConfiguration>),
      ),
    ).toThrow();
    expect(() =>
      feishuConfigurationSchema.parse(
        validFeishu({ dmChatId: "ou_not_a_chat" }),
      ),
    ).toThrow();
  });

  it("accepts only the Feishu group chat id format for group delivery", () => {
    expect(
      feishuConfigurationSchema.parse({
        profile: "send-message",
        receiveIdType: "chat_id",
        receiveId: "oc_group123",
        ownerOpenId: "ou_owner123",
      }),
    ).toMatchObject({ receiveIdType: "chat_id", receiveId: "oc_group123" });
    expect(() =>
      feishuConfigurationSchema.parse({
        profile: "send-message",
        receiveIdType: "chat_id",
        receiveId: "oc_group123",
        ownerOpenId: "ou_owner123",
        dmChatId: "oc_dm123",
      } as unknown),
    ).toThrow();
    expect(() =>
      feishuConfigurationSchema.parse({
        profile: "send-message",
        receiveIdType: "chat_id",
        receiveId: "ou_owner123",
        ownerOpenId: "ou_owner123",
      }),
    ).toThrow();
  });

  it("round-trips a DM binding with its validated chat id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "send-message-feishu-"));
    roots.push(root);
    const store = new FeishuConfigurationStore(root);
    const config = validFeishu();

    await store.save(config);

    await expect(store.load()).resolves.toEqual(config);
  });

  it("requires an explicit rebind for an old DM config without dmChatId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "send-message-feishu-"));
    roots.push(root);
    await writeFile(
      path.join(root, "feishu.json"),
      JSON.stringify({
        profile: "send-message",
        receiveIdType: "open_id",
        receiveId: "ou_owner123",
        ownerOpenId: "ou_owner123",
      }),
      { mode: 0o600 },
    );

    await expect(
      new FeishuConfigurationStore(root).load(),
    ).rejects.toMatchObject({
      code: "FEISHU_REBIND_REQUIRED",
    });
  });
});

describe("MessageConfigStore", () => {
  it("round-trips through owner-only private storage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "send-message-config-"));
    roots.push(root);
    const store = new MessageConfigStore(root);
    const config = {
      schemaVersion: 1 as const,
      defaultChannel: "wechat" as const,
      channels: ["wechat", "feishu"] as ["wechat", "feishu"],
    };

    await store.save(config);

    await expect(store.load()).resolves.toEqual(config);
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(root, "channels.json"))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("rejects a schema-damaged configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "send-message-config-"));
    roots.push(root);
    await writeFile(
      path.join(root, "channels.json"),
      JSON.stringify({ schemaVersion: 99 }),
      { mode: 0o600 },
    );

    await expect(new MessageConfigStore(root).load()).rejects.toThrow(
      "PRIVATE_STORAGE_INVALID",
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a configuration with broad file permissions",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "send-message-config-"));
      roots.push(root);
      const file = path.join(root, "channels.json");
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          defaultChannel: "wechat",
          channels: ["wechat"],
        }),
        { mode: 0o600 },
      );
      await chmod(file, 0o644);

      await expect(new MessageConfigStore(root).load()).rejects.toThrow(
        "PRIVATE_STORAGE_UNSAFE",
      );
    },
  );
});
