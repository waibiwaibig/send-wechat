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

const relayUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.endsWith(".workers.dev") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  });

const installationSchema = z.discriminatedUnion("role", [
  z
    .object({
      schemaVersion: z.literal(1),
      role: z.literal("hub"),
      relayUrl,
      workerName: z
        .string()
        .min(1)
        .max(63)
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
      accountId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      role: z.literal("client"),
      relayUrl,
      deviceId: z
        .string()
        .length(22)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
]);

export type InstallationState = z.infer<typeof installationSchema>;

export class InstallationStoreError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "InstallationStoreError";
  }
}

export class JsonInstallationStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<InstallationState | null> {
    let raw: string;
    try {
      const metadata = await lstat(this.filePath);
      if (
        metadata.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((metadata.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" &&
              metadata.uid !== process.getuid())))
      )
        throw new InstallationStoreError("INSTALLATION_PERMISSIONS_UNSAFE");
      if (!metadata.isFile() || metadata.size > 16 * 1024)
        throw new InstallationStoreError("INSTALLATION_FILE_UNSAFE");
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new InstallationStoreError("INSTALLATION_JSON_INVALID");
    }
    const parsed = installationSchema.safeParse(decoded);
    if (!parsed.success)
      throw new InstallationStoreError("INSTALLATION_SCHEMA_INCOMPATIBLE");
    return parsed.data;
  }

  public async save(state: InstallationState): Promise<void> {
    const parsed = installationSchema.safeParse(state);
    if (!parsed.success)
      throw new InstallationStoreError("INSTALLATION_SCHEMA_INVALID");
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
