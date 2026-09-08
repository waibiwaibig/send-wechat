import { chmodSync, closeSync, mkdirSync, openSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

const SCHEMA_VERSION = 1;
const SCHEMA_HASH = "send-wechat-text-inbox-v1";
const LEASE_MS = 30_000;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 500;
const MAX_POLL_MESSAGES = 50;
const MAX_TEXT_LENGTH = 4000;
const MAX_ID_LENGTH = 256;
const MAX_CONSUMER_ID_LENGTH = 128;

type TextInboxOptions = {
  now?: () => number;
};

type MetadataRow = {
  overflow: number;
  active_consumer: string | null;
  lease_until: number | null;
};

type MessageRow = {
  id: string;
  text: string;
  received_at: number;
};

export type InboundText = {
  id: string;
  text: string;
  receivedAt: number;
};

export type TextInboxPollResult = {
  messages: InboundText[];
  overflow: boolean;
};

export class TextInboxError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(code);
    this.name = "TextInboxError";
  }
}

/**
 * A small owner-only SQLite inbox for text received from the bound user.
 *
 * The database is opened only after an operation needs it. In particular,
 * append() does not create a file when no consumer has first acquired a lease.
 */
export class SqliteTextInbox {
  private database: DatabaseSync | null = null;
  private readonly now: () => number;

  public constructor(
    private readonly filePath: string,
    options: TextInboxOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  public poll(consumerId: string): TextInboxPollResult {
    validateConsumerId(consumerId);
    const database = this.openDatabase(true);
    return this.transaction(database, () => {
      const now = this.currentTime();
      this.prune(database, now);
      const metadata = this.metadata(database);
      if (
        metadata.active_consumer !== null &&
        metadata.lease_until !== null &&
        metadata.lease_until > now &&
        metadata.active_consumer !== consumerId
      ) {
        throw new TextInboxError("INBOX_BUSY", true);
      }

      database
        .prepare(
          `UPDATE metadata
           SET active_consumer = ?, lease_until = ?, overflow = 0
           WHERE schema_version = ?`,
        )
        .run(consumerId, now + LEASE_MS, SCHEMA_VERSION);

      const rows = database
        .prepare(
          `SELECT id, text, received_at
           FROM messages
           ORDER BY sequence ASC
           LIMIT ?`,
        )
        .all(MAX_POLL_MESSAGES) as MessageRow[];
      return {
        messages: rows.map((row) => ({
          id: row.id,
          text: row.text,
          receivedAt: row.received_at,
        })),
        overflow: metadata.overflow === 1,
      };
    });
  }

  public ack(consumerId: string, ids: string[]): void {
    validateConsumerId(consumerId);
    if (!Array.isArray(ids) || ids.length > MAX_MESSAGES) {
      throw new TextInboxError("INBOX_ACK_INVALID");
    }
    const validIds = ids.filter((id) => isValidId(id));
    if (validIds.length !== ids.length)
      throw new TextInboxError("INBOX_ACK_INVALID");

    const database = this.openDatabase(false);
    if (database === null) throw new TextInboxError("INBOX_INACTIVE");
    this.transaction(database, () => {
      const now = this.currentTime();
      this.prune(database, now);
      this.requireLease(database, consumerId, now);
      const statement = database.prepare("DELETE FROM messages WHERE id = ?");
      for (const id of validIds) statement.run(id);
    });
  }

  public release(consumerId: string): void {
    validateConsumerId(consumerId);
    const database = this.openDatabase(false);
    if (database === null) return;
    this.transaction(database, () => {
      const now = this.currentTime();
      this.prune(database, now);
      const metadata = this.metadata(database);
      if (
        metadata.active_consumer !== null &&
        metadata.lease_until !== null &&
        metadata.lease_until > now &&
        metadata.active_consumer !== consumerId
      ) {
        throw new TextInboxError("INBOX_BUSY", true);
      }
      database
        .prepare(
          `UPDATE metadata
           SET active_consumer = NULL, lease_until = NULL
           WHERE schema_version = ?`,
        )
        .run(SCHEMA_VERSION);
    });
  }

  public append(messages: InboundText[]): void {
    if (!Array.isArray(messages))
      throw new TextInboxError("INBOX_APPEND_INVALID");
    const validMessages = messages.filter(isValidMessage);
    if (validMessages.length === 0) return;

    const database = this.openDatabase(false);
    if (database === null) return;
    this.transaction(database, () => {
      const now = this.currentTime();
      this.prune(database, now);
      const metadata = this.metadata(database);
      if (
        metadata.active_consumer === null ||
        metadata.lease_until === null ||
        metadata.lease_until <= now
      ) {
        return;
      }

      const cutoff = now - TTL_MS;
      let available = Number(
        (
          database.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
            count: number;
          }
        ).count,
      );
      available = Math.max(0, MAX_MESSAGES - available);
      let overflow = metadata.overflow === 1;
      const seenInsert = database.prepare(
        `INSERT INTO seen(id, seen_at) VALUES (?, ?)
         ON CONFLICT(id) DO NOTHING`,
      );
      const messageInsert = database.prepare(
        `INSERT INTO messages(id, text, received_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      );
      for (const message of validMessages) {
        if (message.receivedAt < cutoff) {
          // Retain no body for an expired upstream replay. The seen record is
          // still useful for suppressing that replay during the TTL window.
          seenInsert.run(message.id, now);
          continue;
        }
        const seen = seenInsert.run(message.id, now);
        if (Number(seen.changes) !== 1) continue;
        if (available <= 0) {
          overflow = true;
          continue;
        }
        const inserted = messageInsert.run(
          message.id,
          message.text,
          message.receivedAt,
        );
        if (Number(inserted.changes) === 1) available -= 1;
      }
      if (overflow !== (metadata.overflow === 1)) {
        database
          .prepare("UPDATE metadata SET overflow = ? WHERE schema_version = ?")
          .run(overflow ? 1 : 0, SCHEMA_VERSION);
      }
    });
  }

  public close(): void {
    const database = this.database;
    this.database = null;
    database?.close();
  }

  private openDatabase(create: true): DatabaseSync;
  private openDatabase(create: false): DatabaseSync | null;
  private openDatabase(create: boolean): DatabaseSync | null {
    if (this.database !== null) return this.database;
    if (!create && !this.fileExists()) return null;
    this.preparePath(create);
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(this.filePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        timeout: 0,
      });
    } catch {
      throw new TextInboxError("INBOX_SCHEMA_INCOMPATIBLE");
    }
    try {
      database.enableDefensive(true);
      database.exec(
        "PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE;",
      );
      this.initializeOrValidate(database);
      chmodSync(this.filePath, 0o600);
      this.database = database;
      return database;
    } catch (error) {
      database.close();
      if (error instanceof TextInboxError) throw error;
      throw new TextInboxError("INBOX_UNAVAILABLE");
    }
  }

  private fileExists(): boolean {
    try {
      lstatSync(this.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new TextInboxError("INBOX_UNAVAILABLE");
    }
  }

  private preparePath(create: boolean): void {
    if (create) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
        if (process.platform !== "win32")
          chmodSync(dirname(this.filePath), 0o700);
      } catch {
        throw new TextInboxError("INBOX_UNAVAILABLE");
      }
    }
    try {
      const metadata = lstatSync(this.filePath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((metadata.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" &&
              metadata.uid !== process.getuid())))
      ) {
        throw new TextInboxError("INBOX_FILE_UNSAFE");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new TextInboxError("INBOX_INACTIVE");
      try {
        const descriptor = openSync(this.filePath, "wx", 0o600);
        closeSync(descriptor);
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST")
          throw new TextInboxError("INBOX_UNAVAILABLE");
        this.preparePath(false);
      }
    }
  }

  private initializeOrValidate(database: DatabaseSync): void {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    if (tables.length === 0) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE metadata (
          schema_version INTEGER PRIMARY KEY CHECK (schema_version = 1),
          schema_hash TEXT NOT NULL,
          overflow INTEGER NOT NULL CHECK (overflow IN (0, 1)),
          active_consumer TEXT,
          lease_until INTEGER,
          CHECK ((active_consumer IS NULL) = (lease_until IS NULL))
        ) STRICT;
        INSERT INTO metadata(schema_version, schema_hash, overflow)
          VALUES (${SCHEMA_VERSION}, '${SCHEMA_HASH}', 0);
        CREATE TABLE messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          text TEXT NOT NULL,
          received_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX messages_received_at ON messages(received_at);
        CREATE TABLE seen (
          id TEXT PRIMARY KEY NOT NULL,
          seen_at INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX seen_seen_at ON seen(seen_at);
        COMMIT;
      `);
      return;
    }
    const metadata = database
      .prepare(
        "SELECT schema_version, schema_hash FROM metadata WHERE schema_version = ?",
      )
      .get(SCHEMA_VERSION) as
      { schema_version: number; schema_hash: string } | undefined;
    const names = tables.map((table) => table.name).sort();
    if (
      metadata?.schema_version !== SCHEMA_VERSION ||
      metadata.schema_hash !== SCHEMA_HASH ||
      names.length !== 3 ||
      names[0] !== "messages" ||
      names[1] !== "metadata" ||
      names[2] !== "seen"
    ) {
      throw new TextInboxError("INBOX_SCHEMA_INCOMPATIBLE");
    }
  }

  private metadata(database: DatabaseSync): MetadataRow {
    const row = database
      .prepare(
        "SELECT overflow, active_consumer, lease_until FROM metadata WHERE schema_version = ?",
      )
      .get(SCHEMA_VERSION) as MetadataRow | undefined;
    if (row === undefined)
      throw new TextInboxError("INBOX_SCHEMA_INCOMPATIBLE");
    return row;
  }

  private prune(database: DatabaseSync, now: number): void {
    const cutoff = now - TTL_MS;
    database.prepare("DELETE FROM messages WHERE received_at < ?").run(cutoff);
    database.prepare("DELETE FROM seen WHERE seen_at < ?").run(cutoff);
  }

  private requireLease(
    database: DatabaseSync,
    consumerId: string,
    now: number,
  ): void {
    const metadata = this.metadata(database);
    if (
      metadata.active_consumer === consumerId &&
      metadata.lease_until !== null &&
      metadata.lease_until > now
    ) {
      return;
    }
    if (
      metadata.active_consumer !== null &&
      metadata.lease_until !== null &&
      metadata.lease_until > now
    ) {
      throw new TextInboxError("INBOX_BUSY", true);
    }
    throw new TextInboxError("INBOX_INACTIVE");
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TextInboxError("INBOX_CLOCK_INVALID");
    return value;
  }

  private transaction<T>(database: DatabaseSync, operation: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the operation error.
      }
      throw error;
    }
  }
}

function validateConsumerId(value: string): void {
  if (
    typeof value !== "string" ||
    Array.from(value).length === 0 ||
    Array.from(value).length > MAX_CONSUMER_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TextInboxError("INBOX_CONSUMER_INVALID");
  }
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isValidMessage(value: InboundText): value is InboundText {
  return (
    value !== null &&
    typeof value === "object" &&
    isValidId(value.id) &&
    typeof value.text === "string" &&
    Array.from(value.text).length > 0 &&
    Array.from(value.text).length <= MAX_TEXT_LENGTH &&
    !/[\u0000\u007f]/.test(value.text) &&
    Number.isSafeInteger(value.receivedAt) &&
    value.receivedAt >= 0
  );
}
