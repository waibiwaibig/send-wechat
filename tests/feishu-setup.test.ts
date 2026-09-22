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
    content: "bind-code",
    ...overrides,
  };
}

function harness(
  options: {
    existing?: FeishuConfiguration | null;
    profiles?: unknown[];
    bot?: Record<string, unknown>;
    timeoutMs?: number;
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
  const run = vi
    .fn<(args: string[]) => Promise<unknown>>()
    .mockImplementation(async (args) => {
      if (args[0] === "profile")
        return options.profiles ?? [{ name: "send-message" }];
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
      return { close };
    });
  const cli = { run, configure, subscribe };
  const store = { load, save };
  const dependencies: FeishuSetupDependencies = {
    cli,
    store,
    code: () => "bind-code",
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
  return {
    cli,
    store,
    output,
    dependencies,
    emit,
    onOutput,
    close,
  };
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

it("waits for the subscription to be ready before printing the binding challenge", async () => {
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  let handler: EventHandler | undefined;
  const close = vi.fn();
  const output: string[] = [];
  const subscribe = vi.fn(async (callback: EventHandler) => {
    handler = callback;
    await ready;
    return { close };
  });
  const run = vi
    .fn<(args: string[]) => Promise<unknown>>()
    .mockImplementation(async (args) =>
      args[0] === "profile"
        ? [{ name: "send-message" }]
        : { app_name: "Ready Bot", open_id: "ou_bot" },
    );
  const store = {
    load: vi
      .fn<() => Promise<FeishuConfiguration | null>>()
      .mockResolvedValue(null),
    save: vi
      .fn<(value: FeishuConfiguration) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const setup = setupFeishu(
    stateDir,
    {
      onOutput: async (text) => {
        output.push(text);
      },
    },
    {
      cli: {
        run,
        configure: vi.fn().mockResolvedValue(undefined),
        subscribe,
      },
      store,
      code: () => "bind-code",
      now: () => startedAt,
      timeoutMs: 60_000,
    },
  );

  await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
  expect(output).toEqual([]);
  releaseReady();
  await vi.waitFor(() => expect(output.join("")).toContain("bind-code"));
  await handler?.(messageEvent());
  await setup;
  expect(close).toHaveBeenCalledTimes(1);
});

it("rejects a subscription that closes during startup without saving", async () => {
  const app = harness({ timeoutMs: 1_000 });
  app.cli.subscribe.mockImplementationOnce(async () => ({
    close: app.close,
    isOpen: () => false,
  }));
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

it("accepts only a fresh text event with the exact code and owner filters", async () => {
  const app = harness();
  const setup = setupFeishu(
    stateDir,
    { onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));

  const invalidEvents = [
    { type: "other.event" },
    { sender_type: "bot" },
    { message_type: "post" },
    { chat_type: "group" },
    { sender_id: "owner" },
    { chat_id: "chat" },
    { message_id: "m_without_prefix" },
    { create_time: String(startedAt - 1) },
    { content: "wrong-code" },
  ];
  for (const override of invalidEvents) await app.emit(messageEvent(override));
  expect(app.store.save).not.toHaveBeenCalled();
  expect(app.output.join("")).toContain("bind-code");

  await app.emit(messageEvent());
  await setup;
  expect(app.store.save).toHaveBeenCalledWith({
    profile: "send-message",
    receiveIdType: "open_id",
    receiveId: "ou_owner",
    ownerOpenId: "ou_owner",
    dmChatId: "oc_chat",
  });
  expect(app.close).toHaveBeenCalledTimes(1);
});

it("rejects stale events even when their code and shape are otherwise valid", async () => {
  const app = harness();
  const setup = setupFeishu(
    stateDir,
    { onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));

  await app.emit(messageEvent({ create_time: String(startedAt - 10) }));
  expect(app.store.save).not.toHaveBeenCalled();
  await app.emit(messageEvent());
  await setup;
  expect(app.store.save).toHaveBeenCalledTimes(1);
});

it("requires the bot mention and exact code for a group binding", async () => {
  const app = harness({ bot: { app_name: "Group Bot", open_id: "ou_bot" } });
  const setup = setupFeishu(
    stateDir,
    { target: "group", onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));

  const groupEvent = (overrides: Record<string, unknown> = {}) =>
    messageEvent({
      chat_type: "group",
      content: "@Group Bot bind-code",
      mentions: [{ id: "ou_bot", name: "Group Bot" }],
      ...overrides,
    });
  await app.emit(groupEvent({ mentions: [] }));
  await app.emit(
    groupEvent({ mentions: [{ id: "ou_other", name: "Group Bot" }] }),
  );
  await app.emit(groupEvent({ content: "bind-code" }));
  await app.emit(groupEvent({ content: "@Group Bot wrong-code" }));
  expect(app.store.save).not.toHaveBeenCalled();

  await app.emit(groupEvent());
  await setup;
  expect(app.store.save).toHaveBeenCalledWith({
    profile: "send-message",
    receiveIdType: "chat_id",
    receiveId: "oc_chat",
    ownerOpenId: "ou_owner",
  });
  expect(app.output.join("")).toContain("@机器人");
  expect(app.close).toHaveBeenCalledTimes(1);
});

it("rebinds an old DM config only when explicitly requested", async () => {
  const app = harness({
    existing: {
      profile: "send-message",
      receiveIdType: "open_id",
      receiveId: "ou_existing",
      ownerOpenId: "ou_existing",
    } as unknown as FeishuConfiguration,
  });
  const setup = setupFeishu(
    stateDir,
    { target: "dm", rebind: true, onOutput: app.onOutput },
    app.dependencies,
  );
  await vi.waitFor(() => expect(app.cli.subscribe).toHaveBeenCalledTimes(1));
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

it("closes the subscription and does not save when challenge output fails", async () => {
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
