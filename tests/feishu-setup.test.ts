import { expect, it, vi } from "vitest";
import {
  setupFeishu,
  type FeishuSetupDependencies,
} from "../src/feishu/setup.js";
import type { FeishuConfiguration } from "../src/messaging/config.js";

type EventHandler = (event: unknown) => void | Promise<void>;
type Subscription = { close(): void; isOpen?: () => boolean };

const stateDir = "/tmp/send-message-feishu-setup-test";
const startedAt = 1_700_000_000_000;

const existingDm: FeishuConfiguration = {
  profile: "send-message",
  receiveIdType: "open_id",
  receiveId: "ou_existing",
  ownerOpenId: "ou_existing",
  dmChatId: "oc_existing",
};

function messageEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "im.message.receive_v1",
    message_id: "om_binding",
    create_time: String(startedAt),
    chat_id: "oc_chat",
    chat_type: "p2p",
    message_type: "text",
    sender_id: "ou_owner",
    sender_type: "user",
    content: "你好",
    ...overrides,
  };
}

function harness(
  options: {
    existing?: FeishuConfiguration | null;
    profiles?: unknown[];
    app?: Record<string, unknown>;
    bot?: Record<string, unknown>;
    timeoutMs?: number;
    runError?: Error;
    closed?: boolean;
    subscribeGate?: Promise<void>;
  } = {},
) {
  let handler: EventHandler | undefined;
  const close = vi.fn();
  const output: string[] = [];
  const load = vi
    .fn<() => Promise<FeishuConfiguration | null>>()
    .mockResolvedValue(options.existing ?? null);
  const save = vi
    .fn<(value: FeishuConfiguration) => Promise<void>>()
    .mockResolvedValue(undefined);
  const app = options.app ?? {
    app_id: "cli_test_app",
    creator_id: "ou_owner",
    app_name: "Test Bot",
  };
  const run = vi
    .fn<(args: string[]) => Promise<unknown>>()
    .mockImplementation(async (args) => {
      if (args[0] === "profile")
        return options.profiles ?? [{ name: "send-message" }];
      if (args[0] === "api" && args[2]?.includes("applications/me")) {
        if (options.runError !== undefined) throw options.runError;
        return { app };
      }
      if (args[0] === "api")
        return options.bot ?? { app_name: "Test Bot", open_id: "ou_bot" };
      throw new Error(`unexpected CLI call: ${args.join(" ")}`);
    });
  const configure = vi
    .fn<(onOutput: (text: string) => void | Promise<void>) => Promise<void>>()
    .mockResolvedValue(undefined);
  const subscribe = vi
    .fn<(callback: EventHandler) => Promise<Subscription>>()
    .mockImplementation(async (callback) => {
      handler = callback;
      if (options.subscribeGate !== undefined) await options.subscribeGate;
      return {
        close,
        ...(options.closed === true ? { isOpen: () => false } : {}),
      };
    });
  const cli = { run, configure, subscribe };
  const store = { load, save };
  const dependencies: FeishuSetupDependencies = {
    cli,
    store,
    now: () => startedAt,
    timeoutMs: options.timeoutMs ?? 60_000,
  };
  const emit = async (event: unknown) => {
    if (handler === undefined) throw new Error("subscription was not ready");
    await handler(event);
  };
  const onOutput = async (text: string) => {
    output.push(text);
  };
  return { cli, store, output, dependencies, emit, onOutput, close };
}

async function waitForPrompt(app: ReturnType<typeof harness>): Promise<void> {
  await vi.waitFor(() =>
    expect(app.output.join("")).toContain("飞书连接已就绪"),
  );
}

it("configures only when the send-message profile is absent", async () => {
  for (const profiles of [[], [{ name: "send-message" }]]) {
    const app = harness({ profiles });
    const setup = setupFeishu(
      stateDir,
      { onOutput: app.onOutput },
      app.dependencies,
    );
    await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
    await waitForPrompt(app);
    await app.emit(messageEvent());
    await setup;
    expect(app.cli.configure).toHaveBeenCalledTimes(
      profiles.length === 0 ? 1 : 0,
    );
  }
});

it("reuses an existing binding without configuring or subscribing", async () => {
  const app = harness({ existing: existingDm });
  const result = await setupFeishu(
    stateDir,
    { target: "dm", onOutput: app.onOutput },
    app.dependencies,
  );

  expect(result).toEqual(existingDm);
  expect(app.cli.run).toHaveBeenCalledWith([
    "api",
    "GET",
    "/open-apis/bot/v3/info",
  ]);
  expect(app.cli.configure).not.toHaveBeenCalled();
  expect(app.cli.subscribe).not.toHaveBeenCalled();
});

it("requires rebind when the requested target does not match the existing binding", async () => {
  const app = harness({ existing: existingDm });

  await expect(
    setupFeishu(
      stateDir,
      { target: "group", onOutput: app.onOutput },
      app.dependencies,
    ),
  ).rejects.toMatchObject({ code: "FEISHU_REBIND_REQUIRED" });
  expect(app.cli.run).not.toHaveBeenCalled();
  expect(app.cli.subscribe).not.toHaveBeenCalled();
});

it("waits for subscription readiness before printing opening guidance", async () => {
  let releaseReady!: () => void;
  const subscribeGate = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const app = harness({ subscribeGate });
  const setup = setupFeishu(
    stateDir,
    { onOutput: app.onOutput },
    app.dependencies,
  );

  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
  expect(app.output).toEqual([]);
  releaseReady();
  await waitForPrompt(app);
  await app.emit(messageEvent());
  await setup;
  expect(app.close).toHaveBeenCalledTimes(1);
});

it("fetches and validates the application identity before subscribing", async () => {
  const app = harness();
  const setup = setupFeishu(
    stateDir,
    { onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
  await waitForPrompt(app);
  await app.emit(messageEvent());
  await setup;

  expect(app.cli.run).toHaveBeenCalledWith([
    "api",
    "GET",
    "/open-apis/application/v6/applications/me",
    "--params",
    JSON.stringify({ lang: "zh_cn", user_id_type: "open_id" }),
  ]);
});

it("rejects an invalid application identity before opening a subscription", async () => {
  const app = harness({ app: { app_id: 'cli_bad"', creator_id: "ou_owner" } });

  await expect(
    setupFeishu(stateDir, { onOutput: app.onOutput }, app.dependencies),
  ).rejects.toMatchObject({ code: "FEISHU_APP_IDENTITY_INVALID" });
  expect(app.cli.subscribe).not.toHaveBeenCalled();
  expect(app.store.save).not.toHaveBeenCalled();
});

it("rejects a missing or malformed creator id before opening a subscription", async () => {
  for (const creator_id of [undefined, "owner", 'ou_bad"value']) {
    const app = harness({ app: { app_id: "cli_valid", creator_id } });
    await expect(
      setupFeishu(stateDir, { onOutput: app.onOutput }, app.dependencies),
    ).rejects.toMatchObject({ code: "FEISHU_APP_IDENTITY_INVALID" });
    expect(app.cli.subscribe).not.toHaveBeenCalled();
  }
});

it("preserves an upstream identity lookup failure without subscribing or saving", async () => {
  const upstream = Object.assign(new Error("FEISHU_230101"), {
    code: "FEISHU_230101",
  });
  const app = harness({ runError: upstream });

  await expect(
    setupFeishu(stateDir, { onOutput: app.onOutput }, app.dependencies),
  ).rejects.toBe(upstream);
  expect(app.cli.subscribe).not.toHaveBeenCalled();
  expect(app.store.save).not.toHaveBeenCalled();
});

it("shows a direct DM opening link and accepts any first message from the creator", async () => {
  const app = harness({
    app: {
      app_id: "cli_safe-app_1",
      creator_id: "ou_owner",
      app_name: "Safe Bot\nName",
    },
  });
  const setup = setupFeishu(
    stateDir,
    { onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
  await waitForPrompt(app);
  expect(app.output.join("")).toContain(
    "https://applink.feishu.cn/client/bot/open?appId=cli_safe-app_1",
  );
  expect(app.output.join("")).toContain("打开飞书");
  expect(app.output.join("")).toContain("随便发一条消息");
  expect(app.output.join("")).not.toContain("绑定码");

  await app.emit(messageEvent({ message_type: "image", content: undefined }));
  await setup;
  expect(app.store.save).toHaveBeenCalledWith({
    profile: "send-message",
    receiveIdType: "open_id",
    receiveId: "ou_owner",
    ownerOpenId: "ou_owner",
    dmChatId: "oc_chat",
  });
});

it("accepts only a fresh message from the verified creator after the prompt", async () => {
  let releaseOutput!: () => void;
  const outputReady = new Promise<void>((resolve) => {
    releaseOutput = resolve;
  });
  const app = harness();
  const setup = setupFeishu(
    stateDir,
    {
      onOutput: async (text) => {
        app.output.push(text);
        await outputReady;
      },
    },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
  await app.emit(messageEvent());
  expect(app.store.save).not.toHaveBeenCalled();
  releaseOutput();
  await vi.waitFor(() => expect(app.output.join("")).toContain("10 分钟内"));

  await app.emit(messageEvent({ sender_id: "ou_other" }));
  await app.emit(messageEvent({ create_time: String(startedAt - 1) }));
  expect(app.store.save).not.toHaveBeenCalled();
  await app.emit(messageEvent());
  await setup;
  expect(app.store.save).toHaveBeenCalledTimes(1);
});

it("rejects malformed, bot, and wrong-chat events while waiting for a valid DM", async () => {
  const app = harness();
  const setup = setupFeishu(
    stateDir,
    { onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
  await waitForPrompt(app);
  for (const override of [
    { type: "other.event" },
    { sender_type: "bot" },
    { chat_type: "group" },
    { sender_id: "ou_other" },
    { chat_id: "chat" },
    { message_id: "m_without_prefix" },
    { message_type: "" },
    { create_time: "not-a-time" },
  ])
    await app.emit(messageEvent(override));
  expect(app.store.save).not.toHaveBeenCalled();
  await app.emit(messageEvent());
  await setup;
});

it("fails closed when group bot identity is unavailable", async () => {
  const app = harness({ bot: { app_name: "No ID" } });
  await expect(
    setupFeishu(
      stateDir,
      { target: "group", onOutput: app.onOutput },
      app.dependencies,
    ),
  ).rejects.toMatchObject({ code: "FEISHU_APP_IDENTITY_INVALID" });
  expect(app.cli.subscribe).not.toHaveBeenCalled();
});

it("closes a subscription that is already closed during startup", async () => {
  const app = harness({ closed: true });
  const setup = setupFeishu(
    stateDir,
    { onOutput: app.onOutput },
    app.dependencies,
  );
  await expect(setup).rejects.toMatchObject({
    code: "FEISHU_CONNECTION_CLOSED",
  });
  expect(app.store.save).not.toHaveBeenCalled();
  expect(app.close).toHaveBeenCalledTimes(1);
});

it("requires exactly one bot mention and any nonempty text for a group binding", async () => {
  const app = harness({ bot: { open_id: "ou_bot" } });
  const setup = setupFeishu(
    stateDir,
    { target: "group", onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
  await waitForPrompt(app);
  const groupEvent = (overrides: Record<string, unknown> = {}) =>
    messageEvent({
      chat_type: "group",
      content: "@Group Bot 你好",
      mentions: [{ id: "ou_bot", name: "Group Bot" }],
      ...overrides,
    });

  await app.emit(groupEvent({ mentions: [] }));
  await app.emit(
    groupEvent({ mentions: [{ id: "ou_other", name: "Group Bot" }] }),
  );
  await app.emit(groupEvent({ content: "@Group Bot" }));
  expect(app.store.save).not.toHaveBeenCalled();
  await app.emit(groupEvent());
  await setup;
  expect(app.store.save).toHaveBeenCalledWith({
    profile: "send-message",
    receiveIdType: "chat_id",
    receiveId: "oc_chat",
    ownerOpenId: "ou_owner",
  });
});

it("rebinds an old DM config only after creator verification", async () => {
  const app = harness({ existing: existingDm });
  const setup = setupFeishu(
    stateDir,
    { target: "dm", rebind: true, onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
  await waitForPrompt(app);
  await app.emit(messageEvent());
  await expect(setup).resolves.toMatchObject({
    receiveIdType: "open_id",
    receiveId: "ou_owner",
    dmChatId: "oc_chat",
  });
});

it("times out a rebind without overwriting the existing binding", async () => {
  const app = harness({ existing: existingDm, timeoutMs: 10 });
  const setup = setupFeishu(
    stateDir,
    { target: "dm", rebind: true, onOutput: app.onOutput },
    app.dependencies,
  );

  await expect(setup).rejects.toMatchObject({ code: "FEISHU_BINDING_TIMEOUT" });
  expect(app.store.save).not.toHaveBeenCalled();
  expect(app.store.load).toHaveBeenCalledTimes(1);
  expect(app.close).toHaveBeenCalledTimes(1);
});

it("times out and closes when opening guidance never resolves", async () => {
  const app = harness({ timeoutMs: 10 });
  const setup = setupFeishu(
    stateDir,
    {
      onOutput: () => new Promise<void>(() => undefined),
    },
    app.dependencies,
  );

  await expect(setup).rejects.toMatchObject({ code: "FEISHU_BINDING_TIMEOUT" });
  expect(app.store.save).not.toHaveBeenCalled();
  expect(app.close).toHaveBeenCalledTimes(1);
});

it("closes the subscription and does not save when opening guidance fails", async () => {
  const app = harness();
  const outputError = new Error("output failed");
  const setup = setupFeishu(
    stateDir,
    {
      onOutput: async () => {
        throw outputError;
      },
    },
    app.dependencies,
  );

  await expect(setup).rejects.toBe(outputError);
  expect(app.store.save).not.toHaveBeenCalled();
  expect(app.close).toHaveBeenCalledTimes(1);
});
