import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { StateStore } from "../runtime/ports.js";
import type { PersistedState } from "../runtime/state.js";

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: z
      .object({
        botId: z.string().min(1).max(4096),
        userId: z.string().min(1).max(4096),
        baseUrl: z
          .string()
          .max(4096)
          .url()
          .refine((value) => new URL(value).protocol === "https:"),
        boundAt: z
          .string()
          .refine((value) => Number.isFinite(Date.parse(value))),
      })
      .strict(),
    pollCursor: z.string().max(1024 * 1024),
    lastInboundAt: z.number().int().nonnegative().nullable(),
    reminderAttemptedFor: z.number().int().nonnegative().nullable(),
    authStale: z.boolean(),
  })
  .strict();

export class StateFormatError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "StateFormatError";
  }
}

export class JsonStateStore implements StateStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<PersistedState | null> {
    let raw: string;
    try {
      const metadata = await lstat(this.filePath);
      if (
        metadata.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((metadata.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" &&
              metadata.uid !== process.getuid())))
      ) {
        throw new StateFormatError("STATE_PERMISSIONS_UNSAFE");
      }
      if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) {
        throw new StateFormatError("STATE_FILE_UNSAFE");
      }
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new StateFormatError("STATE_JSON_INVALID");
    }
    const result = stateSchema.safeParse(parsed);
    if (!result.success)
      throw new StateFormatError("STATE_SCHEMA_INCOMPATIBLE");
    return result.data;
  }

  public async save(state: PersistedState): Promise<void> {
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) throw new StateFormatError("STATE_SCHEMA_INVALID");
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(parsed.data)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporaryPath, this.filePath);
      if (process.platform !== "win32") await chmod(this.filePath, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async delete(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
