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

export const feishuConfigurationSchema = z
  .strictObject({
    profile: z.literal("send-message"),
    receiveIdType: z.enum(["open_id", "chat_id"]),
    receiveId: z.string().min(1).max(256),
    ownerOpenId: z
      .string()
      .regex(/^ou_[A-Za-z0-9_-]+$/)
      .max(256),
  })
  .refine((value) =>
    value.receiveIdType === "open_id"
      ? value.receiveId === value.ownerOpenId
      : /^oc_[A-Za-z0-9_-]+$/.test(value.receiveId),
  );
export type FeishuConfiguration = z.infer<typeof feishuConfigurationSchema>;

export class FeishuConfigurationStore {
  private readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "feishu.json");
  }
  load(): Promise<FeishuConfiguration | null> {
    return readPrivateJson(this.path, feishuConfigurationSchema);
  }
  save(value: FeishuConfiguration): Promise<void> {
    return writePrivateJson(this.path, feishuConfigurationSchema, value);
  }
}
