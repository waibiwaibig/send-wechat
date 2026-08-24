import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  IdempotencyStoreError,
  SqliteIdempotencyStore,
} from "../src/storage/idempotency-store.js";
import type { IdempotencyEntry } from "../src/runtime/state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function entry(key: string, createdAt = 1000): IdempotencyEntry {
  return {
    key,
    payloadType: "text",
    payloadHash: "a".repeat(64),
    status: "pending",
    createdAt,
    resultCode: "PENDING",
    clientMessageId: null,
  };
}

describe("SQLite idempotency ledger", () => {
  it("inserts, finds, updates, and prunes entries without rewriting runtime state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-ledger-"));
    directories.push(directory);
    const filePath = join(directory, "idempotency.sqlite3");
    const store = new SqliteIdempotencyStore(filePath);

    await store.insert(entry("old", 100));
    await store.insert(entry("current", 200));
    const accepted = {
      ...entry("current", 200),
      status: "accepted" as const,
      resultCode: "ACCEPTED",
      clientMessageId: "client-message-1",
    };
    await store.update(accepted);
    await store.pruneBefore(150);

    await expect(store.find("old")).resolves.toBeNull();
    await expect(store.find("current")).resolves.toEqual(accepted);
    if (process.platform !== "win32")
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("rejects duplicate insertion and an incompatible pre-existing schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-ledger-"));
    directories.push(directory);
    const filePath = join(directory, "idempotency.sqlite3");
    const store = new SqliteIdempotencyStore(filePath);
    await store.insert(entry("same"));
    await expect(store.insert(entry("same"))).rejects.toMatchObject({
      code: "LEDGER_CONFLICT",
    });

    const incompatiblePath = join(directory, "incompatible.sqlite3");
    const database = new DatabaseSync(incompatiblePath);
    database.exec("CREATE TABLE unrelated(value TEXT)");
    database.close();
    await chmod(incompatiblePath, 0o600);

    await expect(
      new SqliteIdempotencyStore(incompatiblePath).find("missing"),
    ).rejects.toBeInstanceOf(IdempotencyStoreError);
  });

  it("validates keys, entries, cutoffs, updates, and owner-only paths", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "send-wechat-ledger-errors-"),
    );
    directories.push(directory);
    const filePath = join(directory, "idempotency.sqlite3");
    const store = new SqliteIdempotencyStore(filePath);
    await expect(store.find("bad key")).rejects.toMatchObject({
      code: "LEDGER_KEY_INVALID",
    });
    await expect(store.pruneBefore(Number.NaN)).rejects.toMatchObject({
      code: "LEDGER_CUTOFF_INVALID",
    });
    await expect(
      store.insert({ ...entry("invalid"), payloadHash: "bad" }),
    ).rejects.toMatchObject({ code: "LEDGER_ENTRY_INVALID" });
    await expect(store.update(entry("missing"))).rejects.toMatchObject({
      code: "LEDGER_ENTRY_MISSING",
    });
    await store.insert(entry("delete-me"));
    await store.delete();
    await expect(store.find("delete-me")).resolves.toBeNull();

    const unsafe = join(directory, "unsafe.sqlite3");
    await writeFile(unsafe, "not sqlite", { mode: 0o600 });
    await expect(
      new SqliteIdempotencyStore(unsafe).find("missing"),
    ).rejects.toMatchObject({
      code: "LEDGER_UNAVAILABLE",
    });
    const target = join(directory, "target.sqlite3");
    await writeFile(target, "not sqlite", { mode: 0o600 });
    const link = join(directory, "link.sqlite3");
    await symlink(target, link);
    await expect(
      new SqliteIdempotencyStore(link).find("missing"),
    ).rejects.toMatchObject({ code: "LEDGER_FILE_UNSAFE" });
    if (process.platform !== "win32") {
      const broad = join(directory, "broad.sqlite3");
      await writeFile(broad, "not sqlite", { mode: 0o644 });
      await chmod(broad, 0o644);
      await expect(
        new SqliteIdempotencyStore(broad).find("missing"),
      ).rejects.toMatchObject({ code: "LEDGER_FILE_UNSAFE" });
    }
  });
});
