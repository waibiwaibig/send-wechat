import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const fakeCodex = vi.hoisted(() => {
  type Event =
    | {
        type: "delta";
        threadId: string;
        turnId: string;
        itemId: string;
        text: string;
      }
    | {
        type: "message-completed";
        threadId: string;
        turnId: string;
        itemId: string;
        text: string;
      }
    | {
        type: "turn-completed";
        threadId: string;
        turnId: string;
        status: string;
      };
  type Listener = (event: Event) => void;

  const control = {
    instances: [] as FakeCodexAppServer[],
    nextThreadNumber: 1,
    autoCompleteInterrupt: false,
    emitEvents: true,
    replyDelayMs: 0,
  };

  class FakeCodexAppServer {
    public readonly starts: Array<{
      threadId: string;
      text: string;
      turnId: string;
    }> = [];
    public readonly resumes: string[] = [];
    public readonly interrupts: Array<{ threadId: string; turnId: string }> =
      [];
    private readonly listeners = new Set<Listener>();
    private closed = false;

    public constructor(options: unknown) {
      void options;
      control.instances.push(this);
    }

    public async connect(): Promise<void> {}

    public async close(): Promise<void> {
      this.closed = true;
    }

    public async createThread(): Promise<string> {
      const threadId = `thread-${control.nextThreadNumber}`;
      control.nextThreadNumber += 1;
      return threadId;
    }

    public async resumeThread(threadId: string): Promise<void> {
      this.resumes.push(threadId);
    }

    public startTurn(threadId: string, text: string): Promise<string> {
      const turnId = `turn-${this.starts.length + 1}`;
      this.starts.push({ threadId, text, turnId });
      if (control.emitEvents) {
        setTimeout(() => {
          if (this.closed) return;
          const itemId = `item-${turnId}`;
          this.emit({
            type: "delta",
            threadId,
            turnId,
            itemId,
            text: `reply:${text}`,
          });
          this.emit({
            type: "message-completed",
            threadId,
            turnId,
            itemId,
            text: `reply:${text}`,
          });
          this.emit({
            type: "turn-completed",
            threadId,
            turnId,
            status: "completed",
          });
        }, control.replyDelayMs);
      }
      return Promise.resolve(turnId);
    }

    public async interruptTurn(
      threadId: string,
      turnId: string,
    ): Promise<void> {
      this.interrupts.push({ threadId, turnId });
      if (control.autoCompleteInterrupt) {
        this.emit({
          type: "turn-completed",
          threadId,
          turnId,
          status: "interrupted",
        });
      }
    }

    public onEvent(listener: Listener): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    private emit(event: Event): void {
      for (const listener of this.listeners) listener(event);
    }
  }

  return { control, FakeCodexAppServer };
});

vi.mock("../src/gateway/codex-client.js", () => ({
  CodexAppServer: fakeCodex.FakeCodexAppServer,
}));

import { APP_VERSION } from "../src/app/version.js";
import { loadOrCreateCapability } from "../src/ipc/capability.js";
import {
  IpcServer,
  requestIpc,
  type IpcServerRequest,
} from "../src/ipc/transport.js";
import {
  SqliteTextInbox,
  type InboundText,
} from "../src/messaging/text-inbox.js";
import type { PlatformPaths } from "../src/platform/paths.js";
import { runGateway, gatewayStatusSchema } from "../src/gateway/runtime.js";
import { gatewayPaths } from "../src/gateway/paths.js";
import {
  gatewayConfigSchema,
  readGatewayFile,
  writeGatewayFile,
  type GatewayConfig,
} from "../src/gateway/storage.js";

type SentText = { text: string; idempotencyKey: string };

type RuntimeHarness = {
  root: string;
  hub: PlatformPaths;
  config: GatewayConfig;
  capability: string;
  inbox: SqliteTextInbox;
  server: IpcServer;
  requests: IpcServerRequest[];
  sent: SentText[];
  polls: number;
  releases: string[];
  seed: InboundText[] | undefined;
  duplicateFirstPoll: boolean;
  runs: Promise<void>[];
  controllers: AbortController[];
};

const harnesses: RuntimeHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses) {
    for (const controller of harness.controllers) controller.abort();
  }
  await Promise.all(
    harnesses.flatMap(({ runs }) =>
      runs.map((run) =>
        Promise.race([
          run.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]),
      ),
    ),
  );
  await Promise.all(
    harnesses.map(async (harness) => {
      await harness.server.close();
      harness.inbox.close();
      await rm(harness.root, { recursive: true, force: true });
    }),
  );
  harnesses.splice(0);
  fakeCodex.control.instances.length = 0;
  fakeCodex.control.nextThreadNumber = 1;
  fakeCodex.control.autoCompleteInterrupt = false;
  fakeCodex.control.emitEvents = true;
  fakeCodex.control.replyDelayMs = 0;
});

function message(id: string, text: string): InboundText {
  return { id, text, receivedAt: Date.now() };
}

function hubPaths(
  root: string,
  endpoint: string,
  capabilityFile: string,
): PlatformPaths {
  const stateDir = join(root, "hub-state");
  const platform =
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
      ? process.platform
      : (() => {
          throw new Error(`unsupported test platform: ${process.platform}`);
        })();
  const arch =
    process.arch === "x64" || process.arch === "arm64"
      ? process.arch
      : (() => {
          throw new Error(`unsupported test architecture: ${process.arch}`);
        })();
  return {
    platform,
    arch,
    username: "alice",
    stateDir,
    logDir: join(stateDir, "logs"),
    runDir: join(stateDir, "run"),
    socketPath: endpoint,
    ipcEndpoint: endpoint,
    stateFile: join(stateDir, "state.json"),
    installationFile: join(stateDir, "installation.json"),
    idempotencyFile: join(stateDir, "idempotency.sqlite3"),
    capabilityFile,
    clientCredentialFile: join(stateDir, "client-credential.json"),
    tempDir: join(stateDir, "tmp"),
    serviceConfigPath: join(root, "hub.plist"),
  };
}

function inboxFailure(error: unknown): {
  ok: false;
  error: { code: string; retryable: boolean };
} {
  const candidate = error as { code?: unknown };
  const code =
    typeof candidate.code === "string" && /^INBOX_[A-Z_]+$/.test(candidate.code)
      ? candidate.code
      : "INBOX_UNAVAILABLE";
  return { ok: false, error: { code, retryable: code === "INBOX_BUSY" } };
}

async function createHarness(
  options: {
    seed?: InboundText[];
    duplicateFirstPoll?: boolean;
  } = {},
): Promise<RuntimeHarness> {
  const root = await mkdtemp(join(tmpdir(), "gw-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\send-wechat-gateway-${process.pid}-${randomUUID()}`
      : join(root, "d.sock");
  const capabilityFile = join(root, "capability");
  const hub = hubPaths(root, endpoint, capabilityFile);
  const capability = await loadOrCreateCapability(capabilityFile);
  const config: GatewayConfig = {
    schemaVersion: 1,
    installationId: randomUUID(),
    codexExecutable: process.execPath,
    workingDirectory: root,
    searchPath: process.env.PATH ?? "",
  };
  await writeGatewayFile(gatewayPaths(hub).config, gatewayConfigSchema, config);

  const inbox = new SqliteTextInbox(join(root, "inbox.sqlite3"));
  const requests: IpcServerRequest[] = [];
  const sent: SentText[] = [];
  const harness: RuntimeHarness = {
    root,
    hub,
    config,
    capability,
    inbox,
    server: undefined as unknown as IpcServer,
    requests,
    sent,
    polls: 0,
    releases: [] as string[],
    seed: options.seed,
    duplicateFirstPoll: options.duplicateFirstPoll ?? false,
    runs: [] as Promise<void>[],
    controllers: [],
  };
  let seedInjected = false;
  harness.server = new IpcServer({
    endpoint,
    tempDir: join(root, "ipc-tmp"),
    capability,
    appVersion: APP_VERSION,
    async handle(request) {
      requests.push(request);
      if (request.command === "inbox_poll") {
        harness.polls += 1;
        try {
          const result = inbox.poll(request.consumerId);
          if (!seedInjected && harness.seed !== undefined) {
            seedInjected = true;
            inbox.append(harness.seed);
          }
          if (
            harness.duplicateFirstPoll &&
            harness.polls === 2 &&
            result.messages.length > 0
          ) {
            return {
              ok: true,
              result: {
                ...result,
                messages: [...result.messages, ...result.messages],
              },
            };
          }
          return { ok: true, result };
        } catch (error) {
          return inboxFailure(error);
        }
      }
      if (request.command === "inbox_ack") {
        try {
          inbox.ack(request.consumerId, request.ids);
          return { ok: true, result: {} };
        } catch (error) {
          return inboxFailure(error);
        }
      }
      if (request.command === "inbox_release") {
        try {
          inbox.release(request.consumerId);
          harness.releases.push(request.consumerId);
          return { ok: true, result: {} };
        } catch (error) {
          return inboxFailure(error);
        }
      }
      if (request.command === "send_text") {
        sent.push({
          text: request.text,
          idempotencyKey: request.idempotencyKey,
        });
        return { ok: true, result: { state: "accepted" } };
      }
      return { ok: true, result: {} };
    },
  });
  await harness.server.start();
  harnesses.push(harness);
  return harness;
}

function instance(
  index = 0,
): InstanceType<typeof fakeCodex.FakeCodexAppServer> {
  const value = fakeCodex.control.instances[index];
  if (value === undefined) throw new Error("fake Codex instance is missing");
  return value;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  attempts = 300,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await tick();
  }
  throw new Error("runtime condition was not reached");
}

function run(harness: RuntimeHarness, signal: AbortSignal): Promise<void> {
  const operation = runGateway(harness.config, harness.hub, signal);
  harness.runs.push(operation);
  void operation.catch(() => undefined);
  return operation;
}

async function stop(
  harness: RuntimeHarness,
  signal: AbortController,
  operation = harness.runs.at(-1),
): Promise<void> {
  signal.abort();
  await operation;
}

async function readStatus(harness: RuntimeHarness) {
  return readGatewayFile(gatewayPaths(harness.hub).status, gatewayStatusSchema);
}

describe("gateway runtime integration", () => {
  it("holds the inbox lease while polling and processes inbound, stream, send, ack, duplicate, and ordinary send_text", async () => {
    const harness = await createHarness({
      seed: [message("m1", "hello")],
      duplicateFirstPoll: true,
    });
    const signal = new AbortController();
    harness.controllers.push(signal);
    const operation = run(harness, signal.signal);

    await waitFor(() =>
      harness.sent.some(({ text }) => text.includes("reply:hello")),
    );
    await waitFor(() =>
      harness.requests.some(({ command }) => command === "inbox_ack"),
    );
    await waitFor(() => harness.polls >= 3);

    expect(instance().starts).toEqual([
      { threadId: "thread-1", text: "hello", turnId: "turn-1" },
    ]);
    expect(
      harness.requests.filter(({ command }) => command === "inbox_ack"),
    ).toHaveLength(1);

    const manual = await requestIpc({
      endpoint: harness.hub.ipcEndpoint,
      capability: harness.capability,
      appVersion: APP_VERSION,
      requestId: "manual-send",
      payload: {
        command: "send_text",
        idempotencyKey: "manual-key",
        text: "ordinary send",
      },
    });
    expect(manual).toEqual({ ok: true, result: { state: "accepted" } });
    expect(harness.sent).toContainEqual({
      text: "ordinary send",
      idempotencyKey: "manual-key",
    });

    await stop(harness, signal);
    await expect(operation).resolves.toBeUndefined();
    expect(harness.releases).toHaveLength(1);
    expect(await readStatus(harness)).toMatchObject({ phase: "stopped" });
  });

  it("treats /newchat as a boundary and starts the following message on a new thread", async () => {
    fakeCodex.control.autoCompleteInterrupt = true;
    const harness = await createHarness({
      seed: [
        message("m1", "first"),
        message("m2", "/newchat"),
        message("m3", "second"),
      ],
    });
    const signal = new AbortController();
    harness.controllers.push(signal);
    const operation = run(harness, signal.signal);

    await waitFor(() => fakeCodex.control.instances[0]?.starts.length === 2);
    expect(
      instance().starts.map(({ threadId, text }) => ({ threadId, text })),
    ).toEqual([
      { threadId: "thread-1", text: "first" },
      { threadId: "thread-2", text: "second" },
    ]);
    expect(instance().starts.map(({ text }) => text)).not.toContain("/newchat");
    await waitFor(() =>
      harness.requests.some(({ command }) => command === "inbox_ack"),
    );

    await stop(harness, signal);
    await expect(operation).resolves.toBeUndefined();
  });

  it("resumes the persisted thread after a clean stop and does not create a replacement", async () => {
    const harness = await createHarness({ seed: [message("m1", "first")] });
    const firstSignal = new AbortController();
    harness.controllers.push(firstSignal);
    const firstRun = run(harness, firstSignal.signal);
    await waitFor(() => fakeCodex.control.instances[0]?.starts.length === 1);
    await waitFor(() =>
      harness.requests.some(({ command }) => command === "inbox_ack"),
    );
    await stop(harness, firstSignal, firstRun);
    await expect(firstRun).resolves.toBeUndefined();

    const secondSignal = new AbortController();
    harness.controllers.push(secondSignal);
    const secondRun = run(harness, secondSignal.signal);
    await waitFor(
      () => fakeCodex.control.instances.length === 2 && harness.polls >= 4,
    );
    harness.inbox.append([message("m2", "after restart")]);
    await waitFor(() => instance(1).starts.length === 1);

    expect(instance(1).resumes).toEqual(["thread-1"]);
    expect(instance(1).starts[0]).toMatchObject({
      threadId: "thread-1",
      text: "after restart",
    });
    expect(fakeCodex.control.instances).toHaveLength(2);
    await stop(harness, secondSignal);
    await expect(secondRun).resolves.toBeUndefined();
  });

  it("refuses to continue or recreate gateway files when the installation directory is removed", async () => {
    const harness = await createHarness();
    const signal = new AbortController();
    harness.controllers.push(signal);
    const operation = run(harness, signal.signal);
    await waitFor(async () => (await readStatus(harness))?.phase === "ready");

    await rm(gatewayPaths(harness.hub).directory, {
      recursive: true,
      force: true,
    });
    signal.abort();
    await expect(operation).rejects.toThrow("GATEWAY_CONFIGURATION_REPLACED");
    await expect(
      access(gatewayPaths(harness.hub).directory),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not create Codex or overwrite the running status when the inbox lease is busy", async () => {
    const harness = await createHarness();
    const firstSignal = new AbortController();
    harness.controllers.push(firstSignal);
    const firstRun = run(harness, firstSignal.signal);
    await waitFor(
      () => fakeCodex.control.instances.length === 1 && harness.polls >= 2,
    );
    const before = await readFile(gatewayPaths(harness.hub).status, "utf8");

    const secondSignal = new AbortController();
    harness.controllers.push(secondSignal);
    const secondRun = run(harness, secondSignal.signal);
    await expect(secondRun).rejects.toThrow("INBOX_BUSY");
    expect(fakeCodex.control.instances).toHaveLength(1);
    expect(await readFile(gatewayPaths(harness.hub).status, "utf8")).toBe(
      before,
    );

    await stop(harness, firstSignal, firstRun);
    await expect(firstRun).resolves.toBeUndefined();
  });

  it("does not replay a turn after the Hub disconnects", async () => {
    fakeCodex.control.replyDelayMs = 200;
    const harness = await createHarness({ seed: [message("m1", "once")] });
    const signal = new AbortController();
    harness.controllers.push(signal);
    const operation = run(harness, signal.signal);
    await waitFor(() => fakeCodex.control.instances[0]?.starts.length === 1);
    await waitFor(() =>
      harness.requests.some(({ command }) => command === "inbox_ack"),
    );

    await harness.server.close();
    await expect(operation).rejects.toThrow();
    expect(instance().starts).toHaveLength(1);
    expect(
      harness.requests.filter(({ command }) => command === "inbox_ack"),
    ).toHaveLength(1);
  });
});
