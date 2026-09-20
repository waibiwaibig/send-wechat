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
    appId: z
      .string()
      .regex(/^cli_[A-Za-z0-9]+$/)
      .max(128),
    appSecret: z.string().min(1).max(4096),
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

export class FeishuCredentialStore {
  private async entry() {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry("send-message", "feishu");
  }
  async load(): Promise<FeishuConfiguration | null> {
    const raw = (await this.entry()).getPassword();
    if (raw == null) return null;
    if (raw.length > 8192) throw new Error("FEISHU_CREDENTIAL_INVALID");
    return feishuConfigurationSchema.parse(JSON.parse(raw));
  }
  async save(value: FeishuConfiguration): Promise<void> {
    (await this.entry()).setPassword(
      JSON.stringify(feishuConfigurationSchema.parse(value)),
    );
  }
  async delete(): Promise<void> {
    (await this.entry()).deletePassword();
  }
}
