import { chmodSync, existsSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteTextInbox,
  type InboundText,
} from "../src/messaging/text-inbox.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "send-wechat-inbox-test-"));
  directories.push(directory);
  return { directory, path: join(directory, "text-inbox.sqlite") };
}

function message(id: string, receivedAt: number, text = id): InboundText {
  return { id, text, receivedAt };
}

describe("SQLite text inbox", () => {
  it("does not create storage or collect text before a consumer polls", async () => {
    const paths = await fixture();
    let now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });

    inbox.append([message("early", now)]);
    expect(existsSync(paths.path)).toBe(false);

    expect(inbox.poll("consumer")).toEqual({ messages: [], overflow: false });
    inbox.append([message("active", now)]);
    expect(inbox.poll("consumer")).toEqual({
      messages: [message("active", now)],
      overflow: false,
    });

    now += 31_000;
    inbox.append([message("expired-lease", now)]);
    expect(inbox.poll("consumer")).toEqual({
      messages: [message("active", Date.parse("2026-09-08T00:00:00.000Z"))],
      overflow: false,
    });
    inbox.close();
  });

  it("deduplicates within the retention window, acknowledges, and supports reconnect", async () => {
    const paths = await fixture();
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });

    inbox.poll("first");
    inbox.append([
      message("one", now, "first"),
      message("one", now, "duplicate"),
      message("two", now, "second"),
    ]);
    expect(inbox.poll("first").messages).toEqual([
      message("one", now, "first"),
      message("two", now, "second"),
    ]);
    inbox.ack("first", ["one"]);
    expect(inbox.poll("first").messages).toEqual([
      message("two", now, "second"),
    ]);
    inbox.release("first");
    inbox.append([message("one", now, "replayed")]);
    expect(inbox.poll("reconnected").messages).toEqual([
      message("two", now, "second"),
    ]);
    inbox.close();
  });

  it("enforces one lease, retains unacknowledged messages, and reports overflow", async () => {
    const paths = await fixture();
    let now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });

    inbox.poll("first");
    expect(() => inbox.poll("second")).toThrowError("INBOX_BUSY");
    inbox.append(
      Array.from({ length: 501 }, (_, index) =>
        message(`message-${index}`, now),
      ),
    );
    const firstPage = inbox.poll("first");
    expect(firstPage.messages).toHaveLength(50);
    expect(firstPage.overflow).toBe(true);
    expect(inbox.poll("first").overflow).toBe(false);

    now += 31_000;
    expect(inbox.poll("second").messages).toHaveLength(50);
    inbox.release("second");
    inbox.close();
  });

  it("ignores invalid text and expires old messages", async () => {
    const paths = await fixture();
    let now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });

    inbox.poll("consumer");
    inbox.append([
      message("valid", now, "ok"),
      message("empty", now, ""),
      message("long", now, "x".repeat(4001)),
      message("old", now - 24 * 60 * 60 * 1000 - 1, "old"),
    ]);
    expect(inbox.poll("consumer").messages).toEqual([
      message("valid", now, "ok"),
    ]);

    now += 24 * 60 * 60 * 1000 + 1;
    expect(inbox.poll("consumer").messages).toEqual([]);
    inbox.close();
  });

  it("rejects an unknown schema and unsafe database paths", async () => {
    const paths = await fixture();
    await writeFile(paths.path, "not a sqlite database", { mode: 0o600 });
    const malformed = new SqliteTextInbox(paths.path);
    expect(() => malformed.poll("consumer")).toThrowError("INBOX_UNAVAILABLE");
    malformed.close();

    await rm(paths.path, { force: true });
    const database = new DatabaseSync(paths.path);
    database.exec(
      "CREATE TABLE metadata(schema_version INTEGER PRIMARY KEY, schema_hash TEXT, overflow INTEGER, active_consumer TEXT, lease_until INTEGER); CREATE TABLE messages(sequence INTEGER PRIMARY KEY, id TEXT, text TEXT, received_at INTEGER); CREATE TABLE seen(id TEXT PRIMARY KEY, seen_at INTEGER); INSERT INTO metadata VALUES (2, 'wrong', 0, NULL, NULL)",
    );
    database.close();
    chmodSync(paths.path, 0o600);
    const unknownVersion = new SqliteTextInbox(paths.path);
    expect(() => unknownVersion.poll("consumer")).toThrowError(
      "INBOX_SCHEMA_INCOMPATIBLE",
    );
    unknownVersion.close();

    await rm(paths.path, { force: true });
    const target = join(paths.directory, "target.sqlite");
    await writeFile(target, "target", { mode: 0o600 });
    symlinkSync(target, paths.path);
    const symlinked = new SqliteTextInbox(paths.path);
    expect(() => symlinked.poll("consumer")).toThrowError("INBOX_FILE_UNSAFE");
    symlinked.close();
  });

  it("rejects stale consumers after lease takeover", async () => {
    const paths = await fixture();
    let now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    inbox.poll("old");
    inbox.append([message("pending", now)]);
    now += 31_000;
    expect(inbox.poll("new").messages).toEqual([
      message("pending", now - 31_000),
    ]);
    expect(() => inbox.ack("old", ["pending"])).toThrowError("INBOX_BUSY");
    expect(() => inbox.release("old")).toThrowError("INBOX_BUSY");
    inbox.close();
  });

  it("fails closed for invalid calls while keeping valid storage usable", async () => {
    const paths = await fixture();
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    expect(() => inbox.poll("")).toThrowError("INBOX_CONSUMER_INVALID");
    inbox.poll("consumer");
    expect(() => inbox.ack("consumer", ["\0"])).toThrowError(
      "INBOX_ACK_INVALID",
    );
    expect(() =>
      inbox.ack(
        "consumer",
        Array.from({ length: 501 }, () => "id"),
      ),
    ).toThrowError("INBOX_ACK_INVALID");
    expect(() => inbox.append(null as never)).toThrowError(
      "INBOX_APPEND_INVALID",
    );
    inbox.append([
      message("empty", now, ""),
      message("long", now, "x".repeat(4001)),
    ]);
    expect(inbox.poll("consumer").messages).toEqual([]);
    inbox.close();
  });

  it("keeps overflow IDs deduplicated until their TTL expires", async () => {
    const paths = await fixture();
    let now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    inbox.poll("consumer");
    const all = Array.from({ length: 501 }, (_, index) =>
      message(`message-${index}`, now),
    );
    inbox.append(all);
    for (;;) {
      const page = inbox.poll("consumer").messages;
      if (page.length === 0) break;
      inbox.ack(
        "consumer",
        page.map((entry) => entry.id),
      );
    }
    inbox.append([message("message-500", now, "replayed")]);
    expect(inbox.poll("consumer").messages).toEqual([]);
    now += 24 * 60 * 60 * 1000 + 1;
    inbox.poll("consumer");
    inbox.append([message("message-500", now, "after ttl")]);
    expect(inbox.poll("consumer").messages).toEqual([
      message("message-500", now, "after ttl"),
    ]);
    inbox.close();
  });

  it("reopens after close without losing an unacknowledged message", async () => {
    const paths = await fixture();
    let now = Date.parse("2026-09-08T00:00:00.000Z");
    const first = new SqliteTextInbox(paths.path, { now: () => now });
    first.poll("consumer");
    first.append([message("survive", now)]);
    first.close();

    const reopened = new SqliteTextInbox(paths.path, { now: () => now });
    expect(() => reopened.poll("other")).toThrowError("INBOX_BUSY");
    now += 31_000;
    expect(reopened.poll("other").messages).toEqual([
      message("survive", now - 31_000),
    ]);
    reopened.close();
  });

  it("returns promptly when another SQLite writer holds the database lock", async () => {
    const paths = await fixture();
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    inbox.poll("consumer");
    const lock = new DatabaseSync(paths.path, { timeout: 5000 });
    lock.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    try {
      expect(() => inbox.append([message("locked", now)])).toThrow();
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      inbox.close();
    }
  });
});
