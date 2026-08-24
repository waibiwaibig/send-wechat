import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

import { z } from "zod";

import type { IdempotencyStore } from "../runtime/ports.js";
import type { IdempotencyEntry } from "../runtime/state.js";

const SCHEMA_VERSION = 1;
const SCHEMA_HASH = "send-wechat-idempotency-v1";

const entrySchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    payloadType: z.enum(["text", "file", "reminder"]),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["pending", "accepted", "rejected", "unknown"]),
    createdAt: z.number().int().nonnegative(),
    resultCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/),
    clientMessageId: z.string().min(1).max(256).nullable(),
  })
  .strict();

type LedgerRow = {
  key: string;
  payload_type: "text" | "file" | "reminder";
  payload_hash: string;
  status: "pending" | "accepted" | "rejected" | "unknown";
  created_at: number;
  result_code: string;
  client_message_id: string | null;
};

export class IdempotencyStoreError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "IdempotencyStoreError";
  }
}

export class SqliteIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly filePath: string) {}

  public async find(key: string): Promise<IdempotencyEntry | null> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      throw new IdempotencyStoreError("LEDGER_KEY_INVALID");
    }
    return this.withDatabase((database) => {
      const row = database
        .prepare(
          `SELECT key, payload_type, payload_hash, status, created_at, result_code, client_message_id
           FROM idempotency WHERE key = ?`,
        )
        .get(key) as LedgerRow | undefined;
      return row === undefined ? null : fromRow(row);
    });
  }

  public async insert(entry: IdempotencyEntry): Promise<void> {
    const valid = validateEntry(entry);
    return this.withDatabase((database) => {
      try {
        database
          .prepare(
            `INSERT INTO idempotency
             (key, payload_type, payload_hash, status, created_at, result_code, client_message_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...toBindings(valid));
      } catch {
        const existing = database
          .prepare("SELECT 1 AS present FROM idempotency WHERE key = ?")
          .get(valid.key);
        if (existing !== undefined)
          throw new IdempotencyStoreError("LEDGER_CONFLICT");
        throw new IdempotencyStoreError("LEDGER_WRITE_FAILED");
      }
    });
  }

  public async update(entry: IdempotencyEntry): Promise<void> {
    const valid = validateEntry(entry);
    return this.withDatabase((database) => {
      let result: StatementResultingChanges;
      try {
        result = database
          .prepare(
            `UPDATE idempotency
             SET payload_type = ?, payload_hash = ?, status = ?, created_at = ?,
                 result_code = ?, client_message_id = ?
             WHERE key = ?`,
          )
          .run(
            valid.payloadType,
            valid.payloadHash,
            valid.status,
            valid.createdAt,
            valid.resultCode,
            valid.clientMessageId,
            valid.key,
          );
      } catch {
        throw new IdempotencyStoreError("LEDGER_WRITE_FAILED");
      }
      if (Number(result.changes) !== 1)
        throw new IdempotencyStoreError("LEDGER_ENTRY_MISSING");
    });
  }

  public async pruneBefore(cutoff: number): Promise<void> {
    if (!Number.isSafeInteger(cutoff))
      throw new IdempotencyStoreError("LEDGER_CUTOFF_INVALID");
    return this.withDatabase((database) => {
      database
        .prepare("DELETE FROM idempotency WHERE created_at < ?")
        .run(cutoff);
    });
  }

  public async delete(): Promise<void> {
    await Promise.all(
      [
        this.filePath,
        `${this.filePath}-journal`,
        `${this.filePath}-shm`,
        `${this.filePath}-wal`,
      ].map((path) => rm(path, { force: true })),
    );
  }

  private async withDatabase<T>(
    operation: (database: DatabaseSync) => T,
  ): Promise<T> {
    await this.preparePath();
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(this.filePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        timeout: 5000,
      });
    } catch {
      throw new IdempotencyStoreError("LEDGER_SCHEMA_INCOMPATIBLE");
    }
    try {
      database.enableDefensive(true);
      database.exec(
        "PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE;",
      );
      this.initializeOrValidate(database);
      return operation(database);
    } catch (error) {
      if (error instanceof IdempotencyStoreError) throw error;
      throw new IdempotencyStoreError("LEDGER_UNAVAILABLE");
    } finally {
      database.close();
      if (process.platform !== "win32")
        await chmod(this.filePath, 0o600).catch(() => undefined);
    }
  }

  private async preparePath(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    try {
      const metadata = await lstat(this.filePath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((metadata.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" &&
              metadata.uid !== process.getuid())))
      ) {
        throw new IdempotencyStoreError("LEDGER_FILE_UNSAFE");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
          schema_hash TEXT NOT NULL
        ) STRICT;
        INSERT INTO metadata(schema_version, schema_hash)
          VALUES (${SCHEMA_VERSION}, '${SCHEMA_HASH}');
        CREATE TABLE idempotency (
          key TEXT PRIMARY KEY NOT NULL,
          payload_type TEXT NOT NULL CHECK (payload_type IN ('text', 'file', 'reminder')),
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'unknown')),
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          result_code TEXT NOT NULL,
          client_message_id TEXT
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX idempotency_created_at ON idempotency(created_at);
        COMMIT;
      `);
      return;
    }
    const metadata = database
      .prepare("SELECT schema_version, schema_hash FROM metadata")
      .get() as { schema_version: number; schema_hash: string } | undefined;
    const names = tables.map((table) => table.name).sort();
    if (
      metadata?.schema_version !== SCHEMA_VERSION ||
      metadata.schema_hash !== SCHEMA_HASH ||
      names.length !== 2 ||
      names[0] !== "idempotency" ||
      names[1] !== "metadata"
    ) {
      throw new IdempotencyStoreError("LEDGER_SCHEMA_INCOMPATIBLE");
    }
  }
}

function validateEntry(entry: IdempotencyEntry): IdempotencyEntry {
  const parsed = entrySchema.safeParse(entry);
  if (!parsed.success) throw new IdempotencyStoreError("LEDGER_ENTRY_INVALID");
  return parsed.data;
}

function toBindings(
  entry: IdempotencyEntry,
): [string, string, string, string, number, string, string | null] {
  return [
    entry.key,
    entry.payloadType,
    entry.payloadHash,
    entry.status,
    entry.createdAt,
    entry.resultCode,
    entry.clientMessageId,
  ];
}

function fromRow(row: LedgerRow): IdempotencyEntry {
  return validateEntry({
    key: row.key,
    payloadType: row.payload_type,
    payloadHash: row.payload_hash,
    status: row.status,
    createdAt: row.created_at,
    resultCode: row.result_code,
    clientMessageId: row.client_message_id,
  });
}
