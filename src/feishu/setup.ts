import { randomBytes } from "node:crypto";
import { FeishuCli } from "./cli.js";
import {
  FeishuConfigurationStore,
  feishuConfigurationSchema,
  type FeishuConfiguration,
} from "../messaging/config.js";

export type FeishuSetupOptions = {
  target?: "dm" | "group";
  rebind?: boolean;
  onOutput: (text: string) => void | Promise<void>;
};

type Subscription = { close(): void; isOpen?(): boolean };
type SetupCli = Pick<FeishuCli, "run" | "configure" | "subscribe">;
type SetupStore = Pick<FeishuConfigurationStore, "load" | "save">;
export type FeishuSetupDependencies = {
  cli?: SetupCli;
  store?: SetupStore;
  code?: () => string;
  timeoutMs?: number;
  now?: () => number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Bind only a fresh message carrying the challenge shown on this machine. */
export async function setupFeishu(
  stateDir: string,
  options: FeishuSetupOptions,
  dependencies: FeishuSetupDependencies = {},
): Promise<FeishuConfiguration> {
  const cli = dependencies.cli ?? new FeishuCli(stateDir);
  const store = dependencies.store ?? new FeishuConfigurationStore(stateDir);
  let existing: FeishuConfiguration | null;
  try {
    existing = await store.load();
  } catch (error) {
    const code =
      error !== null && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
    if (!options.rebind || code !== "FEISHU_REBIND_REQUIRED") throw error;
    existing = null;
  }
  if (existing !== null && !options.rebind) {
    if (
      options.target !== undefined &&
      (options.target === "dm") !== (existing.receiveIdType === "open_id")
    )
      throw failure("FEISHU_REBIND_REQUIRED");
    await cli.run(["api", "GET", "/open-apis/bot/v3/info"]);
    return existing;
  }

  const profiles = await cli.run(["profile", "list"]);
  if (!Array.isArray(profiles)) throw failure("FEISHU_PROFILE_INVALID");
  if (!profiles.some((value) => record(value)?.name === "send-message")) {
    await options.onOutput(
      "飞书：请打开接下来显示的官方链接，扫码创建 send-message 专用应用。\n",
    );
    await cli.configure(options.onOutput);
  }
  const bot = record(await cli.run(["api", "GET", "/open-apis/bot/v3/info"]));
  const target =
    options.target ?? (existing?.receiveIdType === "chat_id" ? "group" : "dm");
  const code = (dependencies.code ?? (() => randomBytes(16).toString("hex")))();
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = dependencies.timeoutMs ?? 10 * 60 * 1000;
  let subscription: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let done = false;
  let finish!: (value: FeishuConfiguration) => void;
  let reject!: (reason: Error) => void;
  const bound = new Promise<FeishuConfiguration>((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  // Attach a handler before awaiting startup/output; a timeout must never become unhandled.
  void bound.catch(() => undefined);
  try {
    subscription = await cli.subscribe((raw) => {
      const event = record(raw);
      if (
        done ||
        now() - startedAt >= timeoutMs ||
        event?.type !== "im.message.receive_v1" ||
        event.sender_type !== "user" ||
        event.message_type !== "text" ||
        event.chat_type !== (target === "dm" ? "p2p" : "group") ||
        typeof event.sender_id !== "string" ||
        !/^ou_[A-Za-z0-9_-]+$/.test(event.sender_id) ||
        typeof event.chat_id !== "string" ||
        !/^oc_[A-Za-z0-9_-]+$/.test(event.chat_id) ||
        typeof event.message_id !== "string" ||
        !event.message_id.startsWith("om_") ||
        !Number.isFinite(Number(event.create_time)) ||
        Number(event.create_time) < startedAt ||
        typeof event.content !== "string"
      )
        return;
      let content = event.content.trim();
      if (target === "group") {
        const mentions = Array.isArray(event.mentions) ? event.mentions : [];
        if (mentions.length !== 1) return;
        const mention = record(mentions[0]);
        if (
          typeof bot?.open_id !== "string" ||
          mention?.id !== bot.open_id ||
          typeof mention.name !== "string"
        )
          return;
        const prefix = `@${mention.name}`;
        if (!content.startsWith(prefix)) return;
        content = content.slice(prefix.length).trim();
      }
      if (content !== code) return;
      const parsed = feishuConfigurationSchema.safeParse({
        profile: "send-message",
        receiveIdType: target === "dm" ? "open_id" : "chat_id",
        receiveId: target === "dm" ? event.sender_id : event.chat_id,
        ownerOpenId: event.sender_id,
        ...(target === "dm" ? { dmChatId: event.chat_id } : {}),
      });
      if (!parsed.success) return;
      done = true;
      finish(parsed.data);
    });
    healthTimer = setInterval(() => {
      if (!done && subscription?.isOpen?.() === false) {
        done = true;
        reject(failure("FEISHU_CONNECTION_CLOSED"));
      }
    }, 250);
    timer = setTimeout(
      () => {
        done = true;
        reject(failure("FEISHU_BINDING_TIMEOUT"));
      },
      Math.max(1, timeoutMs - (now() - startedAt)),
    );
    const name =
      typeof bot?.app_name === "string"
        ? bot.app_name.replace(/[\u0000-\u001f\u007f]/g, " ")
        : "刚创建的机器人";
    await options.onOutput(
      target === "dm"
        ? `飞书连接已就绪。请在飞书搜索并打开「${name}」的私聊，发送以下绑定码（10 分钟有效）：\n${code}\n`
        : `飞书连接已就绪。请把「${name}」加入目标群，由你本人 @机器人 后发送以下绑定码（10 分钟有效）：\n${code}\n`,
    );
    const configuration = await bound;
    await store.save(configuration);
    await options.onOutput("飞书接收人已绑定。接下来验证测试消息是否收到。\n");
    return configuration;
  } finally {
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    if (healthTimer !== undefined) clearInterval(healthTimer);
    subscription?.close();
  }
}
