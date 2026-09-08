import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

const absolutePath = z.string().min(1).max(16_384).refine(isAbsolute);

export const gatewayConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installationId: z.string().uuid(),
  codexExecutable: absolutePath,
  workingDirectory: absolutePath,
  searchPath: z.string().max(64 * 1024),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

const messageId = z.string().min(1).max(256);
export const gatewayStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  threadId: z.string().min(1).max(256).nullable(),
  handled: z.array(messageId).max(10_000),
  pending: z.array(messageId).max(50),
  lastError: z.string().max(128).nullable(),
});

export type GatewayState = z.infer<typeof gatewayStateSchema>;

export interface GatewayStateStore {
  load(): Promise<GatewayState>;
  save(state: GatewayState): Promise<void>;
}

export function emptyGatewayState(): GatewayState {
  return {
    schemaVersion: 1,
    threadId: null,
    handled: [],
    pending: [],
    lastError: null,
  };
}

async function checkOwnerPath(file: string, directory = false): Promise<void> {
  const info = await lstat(file);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && info.size > 2 * 1024 * 1024) ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" &&
          info.uid !== process.getuid())))
  ) {
    throw new Error("GATEWAY_STORAGE_UNSAFE");
  }
}

export async function readGatewayFile<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    await checkOwnerPath(dirname(file), true);
    await checkOwnerPath(file);
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error("GATEWAY_STORAGE_INVALID");
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeGatewayFile<T>(
  file: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<void> {
  const parsed = schema.parse(value);
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkOwnerPath(directory, true);
  try {
    await checkOwnerPath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    if (process.platform !== "win32") {
      const parent = await open(directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export class JsonGatewayStateStore implements GatewayStateStore {
  public constructor(
    private readonly file: string,
    private readonly guard?: () => Promise<void>,
  ) {}

  public async load(): Promise<GatewayState> {
    await this.guard?.();
    return (
      (await readGatewayFile(this.file, gatewayStateSchema)) ??
      emptyGatewayState()
    );
  }

  public async save(state: GatewayState): Promise<void> {
    await this.guard?.();
    await writeGatewayFile(this.file, gatewayStateSchema, state);
  }
}
