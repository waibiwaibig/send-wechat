import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { renameFile } from "../platform/atomic-rename.js";

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
    throw new Error("PRIVATE_STORAGE_UNSAFE");
  }
}

export async function readPrivateJson<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    await checkOwnerPath(dirname(file), true);
    await checkOwnerPath(file);
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error("PRIVATE_STORAGE_INVALID");
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writePrivateJson<T>(
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
    await renameFile(temporary, file);
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
