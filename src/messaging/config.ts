import { readPrivateJson, writePrivateJson } from "../storage/private-json.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const channelSchema = z.enum(["wechat", "feishu"]);
export const channelSelectionSchema = z.enum(["wechat", "feishu", "both"]);
export const messageConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    defaultChannel: channelSchema,
    channels: z.array(channelSchema).min(1).max(2),
  })
  .refine(
    (value) =>
      new Set(value.channels).size === value.channels.length &&
      value.channels.includes(value.defaultChannel),
  );
export type MessageConfig = z.infer<typeof messageConfigSchema>;

export class MessageConfigStore {
  private readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "channels.json");
  }
  async load(): Promise<MessageConfig | null> {
    try {
      await lstat(this.path);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return null;
      throw error;
    }
    return readPrivateJson(this.path, messageConfigSchema);
  }
  save(value: MessageConfig): Promise<void> {
    return writePrivateJson(this.path, messageConfigSchema, value);
  }
}

const feishuDmConfigurationSchema = z
  .strictObject({
    profile: z.literal("send-message"),
    receiveIdType: z.literal("open_id"),
    receiveId: z.string().min(1).max(256),
    ownerOpenId: z
      .string()
      .regex(/^ou_[A-Za-z0-9_-]+$/)
      .max(256),
    dmChatId: z
      .string()
      .regex(/^oc_[A-Za-z0-9_-]+$/)
      .max(256),
  })
  .refine((value) => value.receiveId === value.ownerOpenId);

const feishuGroupConfigurationSchema = z.strictObject({
  profile: z.literal("send-message"),
  receiveIdType: z.literal("chat_id"),
  receiveId: z
    .string()
    .regex(/^oc_[A-Za-z0-9_-]+$/)
    .max(256),
  ownerOpenId: z
    .string()
    .regex(/^ou_[A-Za-z0-9_-]+$/)
    .max(256),
});

export const feishuConfigurationSchema = z.discriminatedUnion("receiveIdType", [
  feishuDmConfigurationSchema,
  feishuGroupConfigurationSchema,
]);

const legacyFeishuDmConfigurationSchema = z
  .strictObject({
    profile: z.literal("send-message"),
    receiveIdType: z.literal("open_id"),
    receiveId: z.string().min(1).max(256),
    ownerOpenId: z
      .string()
      .regex(/^ou_[A-Za-z0-9_-]+$/)
      .max(256),
  })
  .refine((value) => value.receiveId === value.ownerOpenId);

function rebindRequired(): Error & { code: string } {
  return Object.assign(new Error("FEISHU_REBIND_REQUIRED"), {
    code: "FEISHU_REBIND_REQUIRED",
  });
}
export type FeishuConfiguration = z.infer<typeof feishuConfigurationSchema>;

export class FeishuConfigurationStore {
  private readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "feishu.json");
  }
  async load(): Promise<FeishuConfiguration | null> {
    const value = await readPrivateJson(
      this.path,
      z.union([feishuConfigurationSchema, legacyFeishuDmConfigurationSchema]),
    );
    if (
      value !== null &&
      value.receiveIdType === "open_id" &&
      !("dmChatId" in value)
    )
      throw rebindRequired();
    return value;
  }
  save(value: FeishuConfiguration): Promise<void> {
    return writePrivateJson(this.path, feishuConfigurationSchema, value);
  }
}
