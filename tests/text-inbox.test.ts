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
  const directory = await mkdtemp(join(tmpdir(), "send-message-inbox-test-"));
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

  it("summarizes accepted, invalid, duplicate, expired, overflow, and inactive messages", async () => {
    const paths = await fixture();
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });

    expect(inbox.append([message("inactive", now)])).toEqual({
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      expired: 0,
      overflow: 0,
      inactive: 1,
    });
    inbox.poll("consumer");
    expect(
      inbox.append([
        message("accepted", now),
        message("accepted", now, "duplicate"),
        message("", now),
        message("expired", now - 24 * 60 * 60 * 1000 - 1),
      ]),
    ).toEqual({
      accepted: 1,
      rejected: 1,
      duplicates: 1,
      expired: 1,
      overflow: 0,
      inactive: 0,
    });
    expect(inbox.append([message("accepted", now)])).toEqual({
      accepted: 0,
      rejected: 0,
      duplicates: 1,
      expired: 0,
      overflow: 0,
      inactive: 0,
    });

    const overflow = Array.from({ length: 500 }, (_, index) =>
      message(`overflow-${index}`, now),
    );
    expect(inbox.append(overflow)).toMatchObject({
      accepted: 499,
      overflow: 1,
      inactive: 0,
    });
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

  it("accepts nonempty text with an explicit empty attachment list", async () => {
    const paths = await fixture();
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    inbox.poll("consumer");

    inbox.append([
      {
        id: "text-without-attachments",
        text: "1",
        receivedAt: now,
        attachments: [],
      },
      {
        id: "empty-without-attachments",
        text: "",
        receivedAt: now,
        attachments: [],
      },
      {
        id: "invalid-attachment",
        text: "1",
        receivedAt: now,
        attachments: [{ type: "file", path: "relative.txt", fileName: "x" }],
      },
    ]);

    expect(inbox.poll("consumer").messages).toEqual([
      message("text-without-attachments", now, "1"),
    ]);
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

  it("persists image and file attachments while allowing empty text", async () => {
    const paths = await fixture();
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    inbox.poll("consumer");
    inbox.append([
      {
        id: "attachments",
        text: "",
        receivedAt: now,
        attachments: [
          { type: "image", path: "/tmp/in.png", fileName: "in.png" },
          { type: "file", path: "/tmp/report.pdf", fileName: "report.pdf" },
        ],
      },
    ]);
    expect(inbox.poll("consumer").messages).toEqual([
      {
        id: "attachments",
        text: "",
        receivedAt: now,
        attachments: [
          { type: "image", path: "/tmp/in.png", fileName: "in.png" },
          { type: "file", path: "/tmp/report.pdf", fileName: "report.pdf" },
        ],
      },
    ]);
    inbox.ack("consumer", ["attachments"]);
    inbox.close();
  });

  it("rejects unsafe or oversized attachment metadata", async () => {
    const paths = await fixture();
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    inbox.poll("consumer");
    inbox.append([
      {
        id: "relative",
        text: "",
        receivedAt: now,
        attachments: [{ type: "file", path: "relative.txt", fileName: "x" }],
      },
      {
        id: "control",
        text: "",
        receivedAt: now,
        attachments: [{ type: "file", path: "/tmp/x", fileName: "bad\nname" }],
      },
      {
        id: "too-many",
        text: "",
        receivedAt: now,
        attachments: Array.from({ length: 11 }, (_, index) => ({
          type: "file" as const,
          path: `/tmp/${index}`,
          fileName: `${index}`,
        })),
      },
    ]);
    expect(inbox.poll("consumer").messages).toEqual([]);
    inbox.close();
  });

  it("checks an existing lease without creating storage", async () => {
    const paths = await fixture();
    let now = Date.parse("2026-09-08T00:00:00.000Z");
    const inbox = new SqliteTextInbox(paths.path, { now: () => now });
    expect(inbox.isActive()).toBe(false);
    expect(existsSync(paths.path)).toBe(false);
    inbox.poll("consumer");
    expect(inbox.isActive()).toBe(true);
    inbox.release("consumer");
    expect(inbox.isActive()).toBe(false);
    now += 31_000;
    expect(inbox.isActive()).toBe(false);
    inbox.close();
  });
});
