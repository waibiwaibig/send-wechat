import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MessageConfigStore,
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
    webhookUrl:
      "https://open.feishu.cn/open-apis/bot/v2/hook/123e4567-e89b-12d3-a456-426614174000",
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

  it("accepts a Feishu webhook URL with an optional signing secret", () => {
    expect(feishuConfigurationSchema.parse(validFeishu())).toEqual(
      validFeishu(),
    );
    expect(
      feishuConfigurationSchema.parse(
        validFeishu({ signingSecret: "signing-secret" }),
      ),
    ).toMatchObject({ signingSecret: "signing-secret" });
  });

  it("rejects Feishu webhook URLs with the wrong shape", () => {
    for (const webhookUrl of [
      "http://open.feishu.cn/open-apis/bot/v2/hook/123e4567-e89b-12d3-a456-426614174000",
      "https://example.com/open-apis/bot/v2/hook/123e4567-e89b-12d3-a456-426614174000",
      "https://open.feishu.cn:443/open-apis/bot/v2/hook/123e4567-e89b-12d3-a456-426614174000",
      "https://user:pass@open.feishu.cn/open-apis/bot/v2/hook/123e4567-e89b-12d3-a456-426614174000",
      "https://open.feishu.cn/open-apis/bot/v2/hook/123e4567-e89b-12d3-a456-426614174000?x=1",
      "https://open.feishu.cn/open-apis/bot/v2/hook/123e4567-e89b-12d3-a456-426614174000#fragment",
      "https://open.feishu.cn/open-apis/bot/v2/hook/not-a-uuid",
    ]) {
      expect(() =>
        feishuConfigurationSchema.parse(validFeishu({ webhookUrl })),
      ).toThrow();
    }
  });

  it("rejects empty or oversized signing secrets", () => {
    expect(() =>
      feishuConfigurationSchema.parse(validFeishu({ signingSecret: "" })),
    ).toThrow();
    expect(() =>
      feishuConfigurationSchema.parse(
        validFeishu({ signingSecret: "x".repeat(4097) }),
      ),
    ).toThrow();
  });

  it("rejects the legacy Feishu application configuration fields", () => {
    expect(() =>
      feishuConfigurationSchema.parse({
        ...validFeishu(),
        appId: "cli_test123",
        appSecret: "secret",
        receiveIdType: "open_id",
        receiveId: "ou_legacy123",
      }),
    ).toThrow();
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
