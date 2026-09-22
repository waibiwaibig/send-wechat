import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: childProcessMock.spawn }));

import { FeishuCli } from "../src/feishu/cli.js";

type SpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  stdio: readonly string[];
};

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly killCalls: string[] = [];
  killed = false;
  closeOnKill = true;
  private closeEmitted = false;

  kill(signal: string): boolean {
    this.killed = true;
    this.killCalls.push(signal);
    if (this.closeOnKill) this.emitCloseOnce(null, signal);
    return true;
  }

  finish(status: number | null = 0, signal: string | null = null): void {
    this.emitCloseOnce(status, signal);
  }

  fail(code: string): void {
    const error = Object.assign(new Error("spawn failed: app_secret"), {
      code,
    });
    this.emit("error", error);
  }

  private emitCloseOnce(status: number | null, signal: string | null): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    queueMicrotask(() => this.emit("close", status, signal));
  }
}

type Spawned = {
  file: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
};

const roots: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();
const realSetImmediate = setImmediate;
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

type SpawnWaiter = {
  resolve: (record: Spawned) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SpawnHarnessState = {
  waiters: Map<number, Set<SpawnWaiter>>;
};

const spawnHarnessStates = new WeakMap<Spawned[], SpawnHarnessState>();

afterEach(async () => {
  vi.useRealTimers();
  childProcessMock.spawn.mockReset();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function spawnHarness(): Spawned[] {
  const spawned: Spawned[] = [];
  const state: SpawnHarnessState = { waiters: new Map() };
  spawnHarnessStates.set(spawned, state);
  childProcessMock.spawn.mockImplementation(
    (file: string, args: string[], options: SpawnOptions) => {
      const child = new FakeChild();
      const record = { file, args, options, child };
      const index = spawned.push(record) - 1;
      const waiters = state.waiters.get(index);
      if (waiters !== undefined) {
        state.waiters.delete(index);
        for (const waiter of waiters) {
          realClearTimeout(waiter.timer);
          waiter.resolve(record);
        }
      }
      return child;
    },
  );
  return spawned;
}

async function waitForSpawn(spawned: Spawned[], index = 0): Promise<Spawned> {
  const processRecord = spawned[index];
  if (processRecord !== undefined) return processRecord;
  const state = spawnHarnessStates.get(spawned);
  if (state === undefined) throw new Error("unknown spawn harness");
  return new Promise<Spawned>((resolve, reject) => {
    const waiters = state.waiters.get(index) ?? new Set<SpawnWaiter>();
    const waiter = {
      resolve: (record: Spawned) => {
        waiters.delete(waiter);
        resolve(record);
      },
      reject: (error: Error) => {
        waiters.delete(waiter);
        reject(error);
      },
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    } satisfies SpawnWaiter;
    waiter.timer = realSetTimeout(() => {
      waiters.delete(waiter);
      if (waiters.size === 0) state.waiters.delete(index);
      waiter.reject(new Error("fake child was not spawned"));
    }, 2_000);
    waiters.add(waiter);
    state.waiters.set(index, waiters);
  });
}

async function makeCli(): Promise<{ cli: FeishuCli; stateDir: string }> {
  const root = await mkdtemp(
    join(tmpdir(), "send-message-feishu-cli-process-"),
  );
  roots.push(root);
  return {
    cli: new FeishuCli(join(root, "state")),
    stateDir: join(root, "state"),
  };
}

function setSecretEnvironment(): void {
  for (const key of [
    "LARKSUITE_CLI_APP_SECRET",
    "LARKSUITE_CLI_PROFILE",
    "OPENCLAW_HOME",
    "HERMES_HOME",
    "FEISHU_TOKEN",
    "LARK_CHANNEL",
  ]) {
    savedEnvironment.set(key, process.env[key]);
    process.env[key] = "secret-value";
  }
}

describe("FeishuCli subprocess boundary", () => {
  it("returns an envelope and appends bot/profile flags with isolated paths", async () => {
    setSecretEnvironment();
    const spawned = spawnHarness();
    const { cli, stateDir } = await makeCli();
    const request = cli.run(["api", "GET", "/open-apis/bot/v3/info"]);
    const processRecord = await waitForSpawn(spawned);
    const payload = JSON.stringify({
      ok: true,
      data: { app_name: "测试机器人" },
    });
    const bytes = Buffer.from(payload);
    const split = bytes.indexOf(Buffer.from("试")) + 1;
    processRecord.child.stdout.write(bytes.subarray(0, split));
    processRecord.child.stdout.write(bytes.subarray(split));
    processRecord.child.finish();

    await expect(request).resolves.toEqual({ app_name: "测试机器人" });
    expect(processRecord.args).toEqual([
      "api",
      "GET",
      "/open-apis/bot/v3/info",
      "--profile",
      "send-message",
      "--as",
      "bot",
      "--format",
      "json",
    ]);
    expect(processRecord.options).toMatchObject({
      cwd: stateDir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(processRecord.file).toMatch(
      /[\\/]@larksuite[\\/]cli[\\/]bin[\\/]lark-cli(?:\.exe)?$/,
    );
    expect(processRecord.options.env).toMatchObject({
      LARKSUITE_CLI_CONFIG_DIR: join(stateDir, "feishu-cli", "config"),
      LARKSUITE_CLI_DATA_DIR: join(stateDir, "feishu-cli", "data"),
    });
    for (const key of [
      "LARKSUITE_CLI_APP_SECRET",
      "LARKSUITE_CLI_PROFILE",
      "OPENCLAW_HOME",
      "HERMES_HOME",
      "FEISHU_TOKEN",
      "LARK_CHANNEL",
    ])
      expect(processRecord.options.env[key]).toBeUndefined();
  });

  it("uses profile flags without bot identity for raw profile output", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const request = cli.run(["profile", "list"]);
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.stdout.write(JSON.stringify({ ok: true, data: [] }));
    processRecord.child.finish();

    await expect(request).resolves.toEqual([]);
    expect(processRecord.args).toEqual([
      "profile",
      "list",
      "--profile",
      "send-message",
    ]);
  });

  it("removes only the dedicated profile and rejects unexpected shared configuration", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const removal = cli.removeProfile();
    const listed = await waitForSpawn(spawned);
    listed.child.stdout.write(JSON.stringify([{ name: "send-message" }]));
    listed.child.finish();
    const removed = await waitForSpawn(spawned, 1);
    expect(removed.args).toEqual([
      "config",
      "remove",
      "--profile",
      "send-message",
    ]);
    removed.child.finish();
    await expect(removal).resolves.toBeUndefined();

    const unexpected = cli.removeProfile();
    const shared = await waitForSpawn(spawned, 2);
    shared.child.stdout.write(JSON.stringify([{ name: "another-app" }]));
    shared.child.finish();
    await expect(unexpected).rejects.toMatchObject({
      code: "CLI_PROFILE_UNEXPECTED",
    });
    expect(spawned).toHaveLength(3);
  });

  it("rejects malformed, rejected, and failed subprocess output without secrets", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();

    const malformed = cli.run(["api", "GET", "/malformed"]);
    const malformedChild = await waitForSpawn(spawned);
    malformedChild.child.stdout.write("{malformed");
    malformedChild.child.finish();
    await expect(malformed).rejects.toMatchObject({
      code: "CLI_MALFORMED_OUTPUT",
    });

    const rejected = cli.run(["api", "GET", "/rejected"]);
    const rejectedChild = await waitForSpawn(spawned, 1);
    rejectedChild.child.stdout.write(
      JSON.stringify({
        ok: false,
        error: { code: "network.failure", message: "app_secret" },
      }),
    );
    rejectedChild.child.finish();
    const rejectedError = await rejected.catch((error: unknown) => error);
    expect(rejectedError).toMatchObject({ code: "CLI_NETWORK_FAILURE" });
    expect(String(rejectedError)).not.toContain("app_secret");

    const failed = cli.run(["api", "GET", "/failed"]);
    const failedChild = await waitForSpawn(spawned, 2);
    failedChild.child.fail("ENOENT");
    const failedError = await failed.catch((error: unknown) => error);
    expect(failedError).toMatchObject({ code: "CLI_NOT_FOUND" });
    expect(String(failedError)).not.toContain("app_secret");
  });

  it("kills a command deterministically when its timeout expires", async () => {
    vi.useFakeTimers();
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const request = cli.run(["api", "GET", "/slow"], { timeoutMs: 10 });
    const outcome = request.catch((error: unknown) => error);
    const processRecord = await waitForSpawn(spawned);
    await vi.advanceTimersByTimeAsync(10);

    await expect(outcome).resolves.toMatchObject({ code: "CLI_TIMEOUT" });
    expect(processRecord.child.killCalls).toEqual(["SIGTERM"]);
    expect(processRecord.child.stdin.writableEnded).toBe(true);
  });

  it("escalates a stubborn command from SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers();
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const request = cli.run(["api", "GET", "/stubborn"], { timeoutMs: 10 });
    const outcome = request.catch((error: unknown) => error);
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.closeOnKill = false;
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(processRecord.child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    processRecord.child.finish(null, "SIGKILL");
    await expect(outcome).resolves.toMatchObject({ code: "CLI_TIMEOUT" });
  });

  it("terminates commands and configure when combined output exceeds 16 MiB", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const request = cli.run(["api", "GET", "/too-large"]);
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(request).rejects.toMatchObject({
      code: "CLI_OUTPUT_TOO_LARGE",
    });
    expect(processRecord.child.killCalls).toEqual(["SIGTERM"]);

    const configure = cli.configure(() => undefined);
    const configureProcess = await waitForSpawn(spawned, 1);
    configureProcess.child.stderr.write(Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(configure).rejects.toMatchObject({
      code: "CLI_OUTPUT_TOO_LARGE",
    });
    expect(configureProcess.child.killCalls).toEqual(["SIGTERM"]);
  });

  it("streams configure output and appends no command defaults", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const output: string[] = [];
    const configuring = cli.configure((text) => {
      output.push(text);
    });
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.stdout.write("open ");
    processRecord.child.stderr.write("the official link\n");
    processRecord.child.finish();

    await expect(configuring).resolves.toBeUndefined();
    expect(output.join("")).toContain("open the official link");
    expect(processRecord.args).toEqual([
      "config",
      "init",
      "--new",
      "--name",
      "send-message",
    ]);
  });

  it("kills configure when its output callback fails", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const callbackError = new Error("output callback app_secret");
    const configuring = cli.configure(() => {
      throw callbackError;
    });
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.stdout.write("configuration output");

    await expect(configuring).rejects.toBe(callbackError);
    expect(processRecord.child.killCalls).toEqual(["SIGTERM"]);
  });

  it("waits for the exact ready marker, parses split UTF-8 NDJSON, and closes stdin", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const events: unknown[] = [];
    const subscribing = cli.subscribe((event) => {
      events.push(event);
    });
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.stderr.write("[event] ready event_key=other\n");
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    let settled = false;
    void subscribing.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    processRecord.child.stderr.write("[event] ready event_key=im.");
    processRecord.child.stderr.write("message.receive_v1\n");
    const event = {
      type: "im.message.receive_v1",
      message_id: "om_message",
      create_time: "1700000000000",
      chat_id: "oc_chat",
      chat_type: "p2p",
      message_type: "text",
      sender_id: "ou_owner",
      sender_type: "user",
      content: "你好",
    };
    const line = Buffer.from(`${JSON.stringify(event)}\n`);
    const split = line.indexOf(Buffer.from("好")) + 1;
    processRecord.child.stdout.write(line.subarray(0, split));
    processRecord.child.stdout.write(line.subarray(split));
    const subscription = await subscribing;
    for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1)
      await new Promise<void>((resolve) => realSetImmediate(resolve));
    expect(events).toEqual([event]);
    expect(processRecord.args).toEqual([
      "event",
      "consume",
      "im.message.receive_v1",
      "--profile",
      "send-message",
      "--as",
      "bot",
    ]);
    expect(processRecord.child.stdin.writable).toBe(true);
    subscription.close();
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    expect(processRecord.child.stdin.writableEnded).toBe(true);
    expect(processRecord.child.killCalls).toEqual(["SIGTERM"]);
    expect(subscription.isOpen?.()).toBe(false);
  });

  it("swallows callback errors while keeping the subscription alive", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const subscribing = cli.subscribe(() => {
      throw new Error("callback app_secret");
    });
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.stderr.write(
      "[event] ready event_key=im.message.receive_v1\n",
    );
    const subscription = await subscribing;
    processRecord.child.stdout.write(`${JSON.stringify({ type: "event" })}\n`);
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    expect(subscription.isOpen?.()).toBe(true);
    subscription.close();
  });

  it("rejects startup errors and shuts down the failed subscription", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const subscribing = cli.subscribe(() => undefined);
    const processRecord = await waitForSpawn(spawned);
    processRecord.child.fail("ENOENT");

    await expect(subscribing).rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
    expect(processRecord.child.killCalls).toEqual(["SIGTERM"]);
  });

  it("preserves structured startup errors from stdout and stderr without secrets", async () => {
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const failure = JSON.stringify({
      ok: false,
      error: {
        type: "validation",
        subtype: "invalid_argument",
        message: "app_secret must not escape",
      },
    });

    const stderrCallback = vi.fn();
    const stderrSubscription = cli.subscribe(stderrCallback);
    const stderrProcess = await waitForSpawn(spawned);
    stderrProcess.child.stderr.write(`${failure}\n`);
    stderrProcess.child.finish(2);
    const stderrError = await stderrSubscription.catch(
      (error: unknown) => error,
    );
    expect(stderrError).toMatchObject({
      code: "CLI_INVALID_ARGUMENT",
      exitCode: 2,
    });
    expect(String(stderrError)).not.toContain("app_secret");
    expect(stderrCallback).not.toHaveBeenCalled();

    const stdoutCallback = vi.fn();
    const stdoutSubscription = cli.subscribe(stdoutCallback);
    const stdoutProcess = await waitForSpawn(spawned, 1);
    stdoutProcess.child.stdout.write(`${failure}\n`);
    stdoutProcess.child.finish(2);
    const stdoutError = await stdoutSubscription.catch(
      (error: unknown) => error,
    );
    expect(stdoutError).toMatchObject({
      code: "CLI_INVALID_ARGUMENT",
      exitCode: 2,
    });
    expect(String(stdoutError)).not.toContain("app_secret");
    expect(stdoutCallback).not.toHaveBeenCalled();
  });

  it("times out startup with fake time and closes the child", async () => {
    vi.useFakeTimers();
    const spawned = spawnHarness();
    const { cli } = await makeCli();
    const subscribing = cli.subscribe(() => undefined);
    const outcome = subscribing.catch((error: unknown) => error);
    const processRecord = await waitForSpawn(spawned);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(outcome).resolves.toMatchObject({ code: "CLI_TIMEOUT" });
    expect(processRecord.child.killCalls).toEqual(["SIGTERM"]);
  });
});
