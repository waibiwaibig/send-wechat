import { describe, expect, it } from "vitest";

import { RuntimeApplication } from "../src/runtime/application.js";
import type {
  CredentialStore,
  IdempotencyStore,
  IlinkPort,
  RuntimeDependencies,
  StateStore,
} from "../src/runtime/ports.js";
import type {
  IdempotencyEntry,
  PersistedState,
  SecretBundle,
} from "../src/runtime/state.js";

class MemoryStateStore implements StateStore {
  public constructor(private state: PersistedState | null) {}

  async load(): Promise<PersistedState | null> {
    return structuredClone(this.state);
  }

  async save(state: PersistedState): Promise<void> {
    this.state = structuredClone(state);
  }

  async delete(): Promise<void> {
    this.state = null;
  }
}

class MemoryCredentialStore implements CredentialStore {
  public constructor(private secret: SecretBundle | null) {}

  async load(): Promise<SecretBundle | null> {
    return structuredClone(this.secret);
  }

  async save(secret: SecretBundle): Promise<void> {
    this.secret = structuredClone(secret);
  }

  async delete(): Promise<void> {
    this.secret = null;
  }

  async available(): Promise<boolean> {
    return true;
  }
}

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  async find(key: string): Promise<IdempotencyEntry | null> {
    const entry = this.entries.get(key);
    return entry === undefined ? null : structuredClone(entry);
  }

  async insert(entry: IdempotencyEntry): Promise<void> {
    if (this.entries.has(entry.key)) throw new Error("conflict");
    this.entries.set(entry.key, structuredClone(entry));
  }

  async update(entry: IdempotencyEntry): Promise<void> {
    this.entries.set(entry.key, structuredClone(entry));
  }

  async pruneBefore(cutoff: number): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < cutoff) this.entries.delete(key);
    }
  }

  async delete(): Promise<void> {
    this.entries.clear();
  }
}

const now = Date.parse("2026-08-24T12:00:00.000Z");

function readyState(): PersistedState {
  return {
    schemaVersion: 1,
    binding: {
      botId: "bot-id",
      userId: "user-id",
      baseUrl: "https://ilinkai.weixin.qq.com",
      boundAt: "2026-08-24T00:00:00.000Z",
    },
    pollCursor: "cursor",
    lastInboundAt: now - 60_000,
    reminderAttemptedFor: null,
    authStale: false,
  };
}

const secret: SecretBundle = {
  schemaVersion: 1,
  botToken: "bot-token",
  contextToken: "context-token",
};

function createApp(
  ilink: IlinkPort,
  state: PersistedState | null = readyState(),
): RuntimeApplication {
  const dependencies: RuntimeDependencies = {
    clock: { now: () => now },
    stateStore: new MemoryStateStore(state),
    credentialStore: new MemoryCredentialStore(secret),
    idempotencyStore: new MemoryIdempotencyStore(),
    ilink,
    audit: { async write() {} },
  };
  return new RuntimeApplication(dependencies);
}

describe("runtime send interface", () => {
  it("accepts a ready text send and suppresses a duplicate locally", async () => {
    let sends = 0;
    const app = createApp({
      async send(request) {
        sends += 1;
        expect(request.payload).toEqual({ type: "text", text: "hello" });
        return { status: "accepted", clientMessageId: "client-message-1" };
      },
    });
    expect(app.isDeliveryIdle()).toBe(true);

    const command = {
      type: "send-text" as const,
      requestId: "request-1",
      idempotencyKey: "job-42",
      text: "hello",
    };
    const first = await app.execute(command);
    const duplicate = await app.execute({ ...command, requestId: "request-2" });

    expect(first).toMatchObject({
      ok: true,
      command: "send",
      result: {
        state: "accepted",
        idempotencyKey: "job-42",
        clientMessageId: "client-message-1",
      },
    });
    expect(duplicate).toMatchObject({
      ok: true,
      command: "send",
      result: { state: "accepted", deduplicated: true },
    });
    expect(sends).toBe(1);
  });

  it("never replays an ambiguous send with the same idempotency key", async () => {
    let sends = 0;
    const app = createApp({
      async send() {
        sends += 1;
        return { status: "unknown", code: "NETWORK_RESULT_UNKNOWN" };
      },
    });

    const first = await app.execute({
      type: "send-text",
      requestId: "request-1",
      idempotencyKey: "job-unknown",
      text: "hello",
    });
    const duplicate = await app.execute({
      type: "send-text",
      requestId: "request-2",
      idempotencyKey: "job-unknown",
      text: "hello",
    });

    expect(first).toMatchObject({
      ok: false,
      error: { code: "RESULT_UNKNOWN" },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: "RESULT_UNKNOWN" },
    });
    expect(sends).toBe(1);
  });

  it("rejects session expiry and conflicting reuse before network I/O", async () => {
    let sends = 0;
    const ilink: IlinkPort = {
      async send() {
        sends += 1;
        return { status: "accepted", clientMessageId: "client-message-1" };
      },
    };
    const blocked = readyState();
    blocked.lastInboundAt = now - 24 * 60 * 60 * 1000;
    const blockedApp = createApp(ilink, blocked);

    const blockedResult = await blockedApp.execute({
      type: "send-text",
      requestId: "request-blocked",
      idempotencyKey: "job-blocked",
      text: "hello",
    });
    expect(blockedResult).toMatchObject({
      ok: false,
      error: { code: "SESSION_EXPIRED" },
    });

    const readyApp = createApp(ilink);
    await readyApp.execute({
      type: "send-text",
      requestId: "request-1",
      idempotencyKey: "job-conflict",
      text: "first",
    });
    const conflict = await readyApp.execute({
      type: "send-text",
      requestId: "request-2",
      idempotencyKey: "job-conflict",
      text: "different",
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    expect(sends).toBe(1);
  });

  it("keeps automatic connection confirmation distinct in the idempotency ledger", async () => {
    let sends = 0;
    const app = createApp({
      async send() {
        sends += 1;
        return { status: "accepted", clientMessageId: "client-message-1" };
      },
    });
    const idempotencyKey = "connection:1787572799000";
    const text =
      "send-wechat 已连接，可以开始使用。 / send-wechat is connected and ready.";

    await app.execute({
      type: "send-text",
      requestId: idempotencyKey,
      idempotencyKey,
      text,
      purpose: "connection",
    });
    const conflict = await app.execute({
      type: "send-text",
      requestId: "manual-request",
      idempotencyKey,
      text,
    });

    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
    expect(sends).toBe(1);
  });

  it("sends one staged file and serializes concurrent delivery operations", async () => {
    const observed: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const app = createApp({
      async send(request) {
        observed.push(
          request.payload.type === "text"
            ? request.payload.text
            : request.payload.fileName,
        );
        if (observed.length === 1) {
          markFirstStarted?.();
          await firstGate;
        }
        return {
          status: "accepted",
          clientMessageId: `client-message-${observed.length}`,
        };
      },
    });

    const first = app.execute({
      type: "send-file",
      requestId: "request-file",
      idempotencyKey: "file-1",
      stagedPath: "/daemon-owned/staged-file",
      fileName: "report.pdf",
      byteLength: 123,
      contentSha256: "a".repeat(64),
    });
    const second = app.execute({
      type: "send-text",
      requestId: "request-text",
      idempotencyKey: "text-2",
      text: "after file",
    });

    await firstStarted;
    expect(observed).toEqual(["report.pdf"]);
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({
      ok: true,
      result: { state: "accepted" },
    });
    await expect(second).resolves.toMatchObject({
      ok: true,
      result: { state: "accepted" },
    });
    expect(app.isDeliveryIdle()).toBe(true);
    expect(observed).toEqual(["report.pdf", "after file"]);
  });

  it("does not hide an authoritative accepted result when metadata audit fails", async () => {
    const dependencies: RuntimeDependencies = {
      clock: { now: () => now },
      stateStore: new MemoryStateStore(readyState()),
      credentialStore: new MemoryCredentialStore(secret),
      idempotencyStore: new MemoryIdempotencyStore(),
      ilink: {
        async send(request) {
          return { status: "accepted", clientMessageId: request.clientId };
        },
      },
      audit: {
        async write() {
          throw new Error("disk full");
        },
      },
    };

    await expect(
      new RuntimeApplication(dependencies).execute({
        type: "send-text",
        requestId: "request-audit",
        idempotencyKey: "audit-failure",
        text: "hello",
      }),
    ).resolves.toMatchObject({ ok: true, result: { state: "accepted" } });
  });

  it("covers the complete preflight rejection matrix and server rejection", async () => {
    const ilink: IlinkPort = {
      async send() {
        return { status: "rejected", code: "ILINK_RET_-2" };
      },
    };
    const missing = createApp(ilink, null);
    await expect(
      missing.execute({
        type: "send-text",
        requestId: "missing",
        idempotencyKey: "missing",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "NOT_LOGGED_IN" } });

    const stale = readyState();
    stale.authStale = true;
    await expect(
      createApp(ilink, stale).execute({
        type: "send-text",
        requestId: "stale",
        idempotencyKey: "stale",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "AUTH_STALE" } });

    const awaiting = readyState();
    awaiting.lastInboundAt = null;
    await expect(
      createApp(ilink, awaiting).execute({
        type: "send-text",
        requestId: "awaiting",
        idempotencyKey: "awaiting",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "AWAITING_MESSAGE" } });

    const app = createApp(ilink);
    await expect(
      app.execute({
        type: "send-text",
        requestId: "bad-key",
        idempotencyKey: "bad key",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "INVALID_IDEMPOTENCY_KEY" } });
    await expect(
      app.execute({
        type: "send-text",
        requestId: "empty",
        idempotencyKey: "empty",
        text: "",
      }),
    ).resolves.toMatchObject({ error: { code: "INVALID_TEXT" } });
    await expect(
      app.execute({
        type: "send-text",
        requestId: "long",
        idempotencyKey: "long",
        text: "😀".repeat(4001),
      }),
    ).resolves.toMatchObject({ error: { code: "INVALID_TEXT" } });
    await expect(
      app.execute({
        type: "send-file",
        requestId: "size",
        idempotencyKey: "size",
        stagedPath: "/tmp/file",
        fileName: "x.txt",
        byteLength: 0,
        contentSha256: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ error: { code: "INVALID_FILE_SIZE" } });
    await expect(
      app.execute({
        type: "send-file",
        requestId: "name",
        idempotencyKey: "name",
        stagedPath: "/tmp/file",
        fileName: "../x.txt",
        byteLength: 1,
        contentSha256: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ error: { code: "INVALID_FILE_NAME" } });
    await expect(
      app.execute({
        type: "send-file",
        requestId: "hash",
        idempotencyKey: "hash",
        stagedPath: "",
        fileName: "x.txt",
        byteLength: 1,
        contentSha256: "bad",
      }),
    ).resolves.toMatchObject({ error: { code: "INVALID_FILE" } });

    const rejected = await app.execute({
      type: "send-text",
      requestId: "rejected",
      idempotencyKey: "rejected",
      text: "hello",
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "SERVER_REJECTED" },
    });
    await expect(
      app.execute({
        type: "send-text",
        requestId: "rejected-2",
        idempotencyKey: "rejected",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "SERVER_REJECTED" } });

    const preSendFailure = createApp({
      async send() {
        return { status: "failed", code: "CDN_UPLOAD_FAILED" };
      },
    });
    await expect(
      preSendFailure.execute({
        type: "send-text",
        requestId: "pre-send",
        idempotencyKey: "pre-send",
        text: "hello",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PRE_SEND_FAILED", retryable: false },
    });
  });

  it("keeps authoritative outcomes when ledger or audit bookkeeping fails", async () => {
    const stateStore = new MemoryStateStore(readyState());
    const credentialStore = new MemoryCredentialStore(secret);
    const idempotency: IdempotencyStore = {
      async find() {
        return null;
      },
      async insert() {},
      async update() {
        throw new Error("ledger update failed");
      },
      async pruneBefore() {},
      async delete() {},
    };
    const dependencies: RuntimeDependencies = {
      clock: { now: () => now },
      stateStore,
      credentialStore,
      idempotencyStore: idempotency,
      ilink: {
        async send() {
          return { status: "accepted", clientMessageId: "id" };
        },
      },
      audit: {
        async write() {
          throw new Error("audit failed");
        },
      },
    };
    await expect(
      new RuntimeApplication(dependencies).execute({
        type: "send-text",
        requestId: "bookkeeping",
        idempotencyKey: "bookkeeping",
        text: "hello",
      }),
    ).resolves.toMatchObject({ ok: true, result: { state: "accepted" } });
  });

  it("settles the delivery chain after bookkeeping and pre-send failures", async () => {
    let pruneCalls = 0;
    const brokenLedger: IdempotencyStore = {
      async find() {
        return null;
      },
      async insert() {},
      async update() {},
      async pruneBefore() {
        pruneCalls += 1;
        throw new Error("ledger unavailable");
      },
      async delete() {},
    };
    const dependency = (ilink: IlinkPort): RuntimeDependencies => ({
      clock: { now: () => now },
      stateStore: new MemoryStateStore(readyState()),
      credentialStore: new MemoryCredentialStore(secret),
      idempotencyStore: brokenLedger,
      ilink,
      audit: { async write() {} },
    });
    const app = new RuntimeApplication(
      dependency({
        async send() {
          return { status: "accepted", clientMessageId: "id" };
        },
      }),
    );
    await expect(
      app.execute({
        type: "send-text",
        requestId: "chain-1",
        idempotencyKey: "chain-1",
        text: "hello",
      }),
    ).rejects.toThrow("ledger unavailable");
    await expect(
      app.execute({
        type: "send-text",
        requestId: "chain-2",
        idempotencyKey: "chain-2",
        text: "hello",
      }),
    ).rejects.toThrow("ledger unavailable");
    expect(pruneCalls).toBe(2);

    const auditFailure: IdempotencyStore = {
      async find() {
        return null;
      },
      async insert() {},
      async update() {
        throw new Error("update unavailable");
      },
      async pruneBefore() {},
      async delete() {},
    };
    const rejected = new RuntimeApplication({
      ...dependency({
        async send() {
          return { status: "rejected", code: "ILINK_RET_-2" };
        },
      }),
      idempotencyStore: auditFailure,
      audit: {
        async write() {
          throw new Error("audit unavailable");
        },
      },
    });
    await expect(
      rejected.execute({
        type: "send-text",
        requestId: "chain-rejected",
        idempotencyKey: "chain-rejected",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "SERVER_REJECTED" } });
    const failed = new RuntimeApplication({
      ...dependency({
        async send() {
          return { status: "failed", code: "CDN_UPLOAD_FAILED" };
        },
      }),
      idempotencyStore: auditFailure,
      audit: {
        async write() {
          throw new Error("audit unavailable");
        },
      },
    });
    await expect(
      failed.execute({
        type: "send-text",
        requestId: "chain-failed",
        idempotencyKey: "chain-failed",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "PRE_SEND_FAILED" } });
  });

  it("maps an iLink auth rejection to stale state and preserves it on replay", async () => {
    const app = createApp(
      {
        async send() {
          return { status: "rejected", code: "ILINK_RET_-14" };
        },
      },
      readyState(),
    );
    const first = await app.execute({
      type: "send-text",
      requestId: "auth-1",
      idempotencyKey: "auth-key",
      text: "hello",
    });
    expect(first).toMatchObject({
      ok: false,
      error: { code: "AUTH_STALE", causeCode: "ILINK_RET_-14" },
    });
    // The application owns its state store; a second call with the same key must not replay the network request.
    const second = await app.execute({
      type: "send-text",
      requestId: "auth-2",
      idempotencyKey: "auth-key",
      text: "hello",
    });
    expect(second).toMatchObject({ ok: false, error: { code: "AUTH_STALE" } });
  });

  it("does not let auth-stale bookkeeping errors escape the authoritative result", async () => {
    const failingStore: IdempotencyStore = {
      async find() {
        return null;
      },
      async insert() {},
      async update() {
        throw new Error("ledger unavailable");
      },
      async pruneBefore() {},
      async delete() {},
    };
    const dependencies: RuntimeDependencies = {
      clock: { now: () => now },
      stateStore: {
        async load() {
          return readyState();
        },
        async save() {
          throw new Error("state unavailable");
        },
        async delete() {},
      },
      credentialStore: new MemoryCredentialStore(secret),
      idempotencyStore: failingStore,
      ilink: {
        async send() {
          return { status: "rejected", code: "ILINK_RET_-14" };
        },
      },
      audit: {
        async write() {
          throw new Error("audit unavailable");
        },
      },
    };
    await expect(
      new RuntimeApplication(dependencies).execute({
        type: "send-text",
        requestId: "auth-bookkeeping",
        idempotencyKey: "auth-bookkeeping",
        text: "hello",
      }),
    ).resolves.toMatchObject({ error: { code: "AUTH_STALE" } });
  });

  it("returns the full status state machine and rejects a delivery queue at capacity", async () => {
    const statuses: Array<
      [PersistedState | null, SecretBundle | null, string]
    > = [
      [null, null, "not_logged_in"],
      [{ ...readyState(), authStale: true }, secret, "auth_stale"],
      [
        { ...readyState(), lastInboundAt: null },
        { ...secret, contextToken: null },
        "awaiting_message",
      ],
      [
        { ...readyState(), lastInboundAt: now - 23 * 60 * 60 * 1000 },
        secret,
        "renewal_due",
      ],
      [
        { ...readyState(), lastInboundAt: now - 25 * 60 * 60 * 1000 },
        secret,
        "blocked",
      ],
    ];
    for (const [stateValue, secretValue, expected] of statuses) {
      const dependencies: RuntimeDependencies = {
        clock: { now: () => now },
        stateStore: new MemoryStateStore(stateValue),
        credentialStore: new MemoryCredentialStore(secretValue),
        idempotencyStore: new MemoryIdempotencyStore(),
        ilink: {
          async send() {
            return { status: "accepted", clientMessageId: "id" };
          },
        },
        audit: { async write() {} },
      };
      await expect(
        new RuntimeApplication(dependencies).execute({
          type: "status",
          requestId: expected,
        }),
      ).resolves.toMatchObject({ result: { state: expected } });
    }

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp({
      async send() {
        await gate;
        return { status: "accepted", clientMessageId: "id" };
      },
    });
    const pending = Array.from({ length: 101 }, (_, index) =>
      app.execute({
        type: "send-text" as const,
        requestId: `queue-${index}`,
        idempotencyKey: `queue-${index}`,
        text: "hello",
      }),
    );
    await expect(pending[100]).resolves.toMatchObject({
      error: { code: "BUSY" },
    });
    release?.();
    await Promise.all(pending.slice(0, 100));
  });
});
