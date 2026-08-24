import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonAuditLog,
  UnsafeAuditEventError,
} from "../src/storage/audit-log.js";
import {
  CredentialStoreError,
  NativeCredentialStore,
} from "../src/storage/credential-store.js";
import {
  JsonStateStore,
  StateFormatError,
} from "../src/storage/state-store.js";
import type { PersistedState, SecretBundle } from "../src/runtime/state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function validState(): PersistedState {
  return {
    schemaVersion: 1,
    binding: {
      botId: "bot-id",
      userId: "user-id",
      baseUrl: "https://ilinkai.weixin.qq.com",
      boundAt: "2026-08-24T00:00:00.000Z",
    },
    pollCursor: "cursor",
    lastInboundAt: 1787558400000,
    reminderAttemptedFor: null,
    authStale: false,
  };
}

describe("owner-only state store", () => {
  it("round-trips schema v1 atomically with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-state-test-"));
    directories.push(directory);
    const file = join(directory, "state.json");
    const store = new JsonStateStore(file);

    await store.save(validState());

    expect(await store.load()).toEqual(validState());
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await readdir(directory)).sort()).toEqual(["state.json"]);
  });

  it("rejects incompatible state instead of migrating or falling back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-state-test-"));
    directories.push(directory);
    const file = join(directory, "state.json");
    await chmod(directory, 0o700);
    await writeFile(
      file,
      JSON.stringify({ ...validState(), schemaVersion: 2 }),
      { mode: 0o600 },
    );

    await expect(new JsonStateStore(file).load()).rejects.toBeInstanceOf(
      StateFormatError,
    );
  });

  it("returns null for a missing state and rejects malformed JSON, unsafe permissions, and invalid schema", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "send-wechat-state-errors-"),
    );
    directories.push(directory);
    const file = join(directory, "state.json");
    await expect(new JsonStateStore(file).load()).resolves.toBeNull();
    await writeFile(file, "not-json", { mode: 0o600 });
    await expect(new JsonStateStore(file).load()).rejects.toMatchObject({
      code: "STATE_JSON_INVALID",
    });
    await writeFile(file, JSON.stringify({ ...validState(), extra: true }), {
      mode: 0o600,
    });
    await expect(new JsonStateStore(file).load()).rejects.toMatchObject({
      code: "STATE_SCHEMA_INCOMPATIBLE",
    });
    if (process.platform !== "win32") {
      await writeFile(file, JSON.stringify(validState()), { mode: 0o644 });
      await chmod(file, 0o644);
      await expect(new JsonStateStore(file).load()).rejects.toMatchObject({
        code: "STATE_PERMISSIONS_UNSAFE",
      });
    }
  });

  it("rejects an invalid state on save and removes the state on delete", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "send-wechat-state-delete-"),
    );
    directories.push(directory);
    const file = join(directory, "state.json");
    const store = new JsonStateStore(file);
    await expect(
      store.save({ ...validState(), schemaVersion: 2 } as never),
    ).rejects.toMatchObject({
      code: "STATE_SCHEMA_INVALID",
    });
    await store.save(validState());
    await store.delete();
    await expect(store.load()).resolves.toBeNull();
  });
});

describe("native credential-store adapter", () => {
  it("stores one versioned secret bundle under the fixed service/account", async () => {
    let stored: string | null = null;
    const entries: Array<{ service: string; account: string }> = [];
    const store = new NativeCredentialStore({
      entryFactory(service, account) {
        entries.push({ service, account });
        return {
          getPassword: () => stored,
          setPassword: (value) => {
            stored = value;
          },
          deletePassword: () => {
            const existed = stored !== null;
            stored = null;
            return existed;
          },
        };
      },
    });
    const secret: SecretBundle = {
      schemaVersion: 1,
      botToken: "bot-token",
      contextToken: "context-token",
    };

    await store.save(secret);
    expect(await store.load()).toEqual(secret);
    await store.delete();
    expect(await store.load()).toBeNull();
    expect(entries.every((entry) => entry.service === "send-wechat")).toBe(
      true,
    );
    expect(entries.every((entry) => entry.account === "binding")).toBe(true);
  });

  it("fails closed for malformed, oversized, invalid, and unavailable credentials", async () => {
    let value: string | null = "not-json";
    const entry = {
      getPassword: () => value,
      setPassword: (next: string) => {
        value = next;
      },
      deletePassword: () => {
        value = null;
      },
    };
    const store = new NativeCredentialStore({ entryFactory: () => entry });
    await expect(store.load()).rejects.toMatchObject({
      code: "CREDENTIAL_SCHEMA_INCOMPATIBLE",
    });
    value = "x".repeat(132 * 1024 + 1);
    await expect(store.load()).rejects.toMatchObject({
      code: "CREDENTIAL_SCHEMA_INCOMPATIBLE",
    });
    value = JSON.stringify({ schemaVersion: 2 });
    await expect(store.load()).rejects.toMatchObject({
      code: "CREDENTIAL_SCHEMA_INCOMPATIBLE",
    });
    await expect(
      store.save({ schemaVersion: 2 } as never),
    ).rejects.toMatchObject({ code: "CREDENTIAL_SCHEMA_INVALID" });

    const unavailable = new NativeCredentialStore({
      entryFactory: () => ({
        getPassword: () => {
          throw new Error("keychain unavailable");
        },
        setPassword: () => {
          throw new Error("keychain unavailable");
        },
        deletePassword: () => {
          throw new Error("keychain unavailable");
        },
      }),
    });
    await expect(unavailable.load()).rejects.toBeInstanceOf(
      CredentialStoreError,
    );
    await expect(
      unavailable.save({
        schemaVersion: 1,
        botToken: "bot",
        contextToken: null,
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
    await expect(unavailable.delete()).rejects.toMatchObject({
      code: "CREDENTIAL_STORE_UNAVAILABLE",
    });
    await expect(unavailable.available()).resolves.toBe(false);
  });
});

describe("metadata-only audit log", () => {
  it("writes only the declared safe fields and prunes files older than seven days", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-log-test-"));
    directories.push(directory);
    const now = Date.parse("2026-08-24T12:00:00.000Z");
    await writeFile(join(directory, "send-wechat-2026-08-10.jsonl"), "old\n", {
      mode: 0o600,
    });
    const log = new JsonAuditLog({
      directory,
      now: () => now,
      maximumBytes: 10 * 1024 * 1024,
    });

    await log.write({
      timestamp: "2026-08-24T12:00:00.000Z",
      requestId: "request-1",
      event: "send_finished",
      payloadType: "text",
      byteSize: 5,
      latencyMs: 7,
      resultCode: "ACCEPTED",
    });

    const names = await readdir(directory);
    expect(names).toEqual(["send-wechat-2026-08-24.jsonl"]);
    const contents = await readFile(join(directory, names[0]!), "utf8");
    expect(JSON.parse(contents)).toEqual({
      timestamp: "2026-08-24T12:00:00.000Z",
      request_id: "request-1",
      event: "send_finished",
      payload_type: "text",
      byte_size: 5,
      latency_ms: 7,
      result_code: "ACCEPTED",
    });
    expect(contents).not.toMatch(/bot-token|context-token|hello|\/Users\//);
  });

  it("rejects unsafe audit metadata and makes room for a bounded log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-log-errors-"));
    directories.push(directory);
    const event = {
      timestamp: "2026-08-24T12:00:00.000Z",
      requestId: "request-1",
      event: "send_finished",
      payloadType: "text" as const,
      byteSize: 1,
      latencyMs: 1,
      resultCode: "ACCEPTED",
    };
    const log = new JsonAuditLog({
      directory,
      now: () => Date.parse("2026-08-24T12:00:00.000Z"),
      maximumBytes: 500,
    });
    await expect(
      log.write({ ...event, requestId: "not safe" }),
    ).rejects.toBeInstanceOf(UnsafeAuditEventError);
    await expect(log.write({ ...event, byteSize: -1 })).rejects.toMatchObject({
      message: "UNSAFE_AUDIT_EVENT",
    });
    await expect(
      log.write({ ...event, latencyMs: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toBeInstanceOf(UnsafeAuditEventError);
    await expect(log.write({ ...event, event: "Bad" })).rejects.toBeInstanceOf(
      UnsafeAuditEventError,
    );
    await expect(
      log.write({ ...event, resultCode: "bad" }),
    ).rejects.toBeInstanceOf(UnsafeAuditEventError);
    await expect(
      log.write({ ...event, payloadType: "other" as never }),
    ).rejects.toBeInstanceOf(UnsafeAuditEventError);

    await writeFile(
      join(directory, "send-wechat-2026-08-23.jsonl"),
      "x".repeat(450),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "send-wechat-2026-08-22.jsonl"),
      "y".repeat(10),
      { mode: 0o600 },
    );
    await log.write(event);
    await log.write({ ...event, requestId: "request-2" });
    expect(
      (await readdir(directory)).some((name) => name.endsWith(".jsonl")),
    ).toBe(true);
  });
});
