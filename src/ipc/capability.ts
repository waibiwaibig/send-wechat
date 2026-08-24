import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;

export class CapabilityError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "CapabilityError";
  }
}

export async function loadCapability(filePath: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CapabilityError("CAPABILITY_NOT_INITIALIZED");
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CapabilityError("CAPABILITY_FILE_UNSAFE");
  }
  if (metadata.size > 128)
    throw new CapabilityError("CAPABILITY_FORMAT_INVALID");
  if (
    process.platform !== "win32" &&
    ((metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid()))
  ) {
    throw new CapabilityError("CAPABILITY_PERMISSIONS_UNSAFE");
  }
  const existing = (await readFile(filePath, "utf8")).trim();
  if (!CAPABILITY_PATTERN.test(existing)) {
    throw new CapabilityError("CAPABILITY_FORMAT_INVALID");
  }
  return existing;
}

export async function loadOrCreateCapability(
  filePath: string,
): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dirname(filePath), 0o700);

  const value = randomBytes(32).toString("hex");
  try {
    const handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${value}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  return loadCapability(filePath);
}
