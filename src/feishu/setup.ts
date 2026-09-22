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

/** Bind the first fresh message sent by the verified application creator. */
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
  const target =
    options.target ?? (existing?.receiveIdType === "chat_id" ? "group" : "dm");
  const appResponse = record(
    await cli.run([
      "api",
      "GET",
      "/open-apis/application/v6/applications/me",
      "--params",
      JSON.stringify({ lang: "zh_cn", user_id_type: "open_id" }),
    ]),
  );
  const app = record(appResponse?.app);
  const appId = typeof app?.app_id === "string" ? app.app_id : undefined;
  const creatorId =
    typeof app?.creator_id === "string" ? app.creator_id : undefined;
  if (
    appId === undefined ||
    !/^cli_[A-Za-z0-9_-]+$/.test(appId) ||
    creatorId === undefined ||
    !/^ou_[A-Za-z0-9_-]+$/.test(creatorId)
  )
    throw failure("FEISHU_APP_IDENTITY_INVALID");
  const bot =
    target === "group"
      ? record(await cli.run(["api", "GET", "/open-apis/bot/v3/info"]))
      : null;
  if (
    target === "group" &&
    (typeof bot?.open_id !== "string" ||
      !/^ou_[A-Za-z0-9_-]+$/.test(bot.open_id))
  )
    throw failure("FEISHU_APP_IDENTITY_INVALID");
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = dependencies.timeoutMs ?? 10 * 60 * 1000;
  let subscription: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let done = false;
  let readyAt: number | undefined;
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
      const messageTime = Number(event?.create_time);
      if (
        done ||
        readyAt === undefined ||
        now() - startedAt >= timeoutMs ||
        event?.type !== "im.message.receive_v1" ||
        event.sender_type !== "user" ||
        event.chat_type !== (target === "dm" ? "p2p" : "group") ||
        typeof event.sender_id !== "string" ||
        !/^ou_[A-Za-z0-9_-]+$/.test(event.sender_id) ||
        event.sender_id !== creatorId ||
        typeof event.chat_id !== "string" ||
        !/^oc_[A-Za-z0-9_-]+$/.test(event.chat_id) ||
        typeof event.message_id !== "string" ||
        !event.message_id.startsWith("om_") ||
        !Number.isFinite(messageTime) ||
        messageTime < readyAt ||
        (target === "dm" &&
          (typeof event.message_type !== "string" ||
            event.message_type.trim().length === 0)) ||
        (target === "group" &&
          (event.message_type !== "text" || typeof event.content !== "string"))
      )
        return;
      let content =
        typeof event.content === "string" ? event.content.trim() : "";
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
        if (content.length === 0) return;
      }
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
      typeof app?.app_name === "string" && app.app_name.trim().length > 0
        ? app.app_name.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
        : "刚创建的机器人";
    const link = `https://applink.feishu.cn/client/bot/open?appId=${appId}`;
    const guidance = options.onOutput(
      target === "dm"
        ? `飞书连接已就绪。\n1. 在电脑或手机上打开飞书，切换到创建应用时使用的账号和企业。\n2. 点击此链接打开「${name}」的私聊：\n${link}\n   电脑：在顶部搜索框搜索「${name}」（应用/机器人），选择后点击“发消息”；手机：在消息页顶部搜索「${name}」（应用/机器人），选择后点击“发消息”。\n   如果链接没有自动打开，请复制到你使用飞书的电脑或手机浏览器中打开。\n3. 随便发一条消息，例如“你好”，即可完成连接（10 分钟内）。\n`
        : `飞书连接已就绪。\n1. 在电脑或手机上打开飞书，切换到创建应用时使用的账号和企业。\n2. 在群设置→群机器人→添加机器人中搜索并添加「${name}」。\n3. 在群里 @「${name}」后随便发送一条文字消息，即可完成连接（10 分钟内）。\n`,
    );
    await Promise.race([
      guidance,
      bound.then(
        () => undefined,
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    readyAt = now();
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
