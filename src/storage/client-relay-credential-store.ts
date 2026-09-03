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

import {
  NativeRelayCredentialStore,
  RelayCredentialStoreError,
  type RelayCredential,
  type ClientRelayCredential,
} from "./relay-credential-store.js";
import type { PlatformPaths } from "../platform/paths.js";

const MAX_STORED_BYTES = 64 * 1024;

const clientCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: z.literal("client"),
    deviceId: z
      .string()
      .length(22)
      .regex(/^[A-Za-z0-9_-]+$/),
    deviceKey: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

type PosixMetadata = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  uid: number;
  size: number;
};

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnerOnlyDirectory(metadata: PosixMetadata): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new RelayCredentialStoreError("RELAY_CREDENTIAL_PERMISSIONS_UNSAFE");
  const uid = currentUid();
  if (
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o777) !== 0o700
  )
    throw new RelayCredentialStoreError("RELAY_CREDENTIAL_PERMISSIONS_UNSAFE");
}

function assertOwnerOnlyFile(metadata: PosixMetadata): void {
  if (metadata.isSymbolicLink())
    throw new RelayCredentialStoreError("RELAY_CREDENTIAL_PERMISSIONS_UNSAFE");
  if (!metadata.isFile())
    throw new RelayCredentialStoreError("RELAY_CREDENTIAL_FILE_UNSAFE");
  const uid = currentUid();
  if (
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o777) !== 0o600
  )
    throw new RelayCredentialStoreError("RELAY_CREDENTIAL_PERMISSIONS_UNSAFE");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureOwnerOnlyParent(
  filePath: string,
  create: boolean,
): Promise<boolean> {
  const directory = dirname(filePath);
  try {
    assertOwnerOnlyDirectory(await lstat(directory));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return false;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  assertOwnerOnlyDirectory(await lstat(directory));
  return true;
}

/**
 * Stores only a paired Linux client credential in an owner-only file.
 *
 * This store deliberately has no keyring dependency. A Hub continues to use
 * NativeRelayCredentialStore, while a Linux client can run in SSH/WSL/headless
 * environments that have no Secret Service session.
 */
export class OwnerOnlyClientRelayCredentialStore {
  public constructor(private readonly filePath: string) {}

  public async load(): Promise<ClientRelayCredential | null> {
    if (!(await ensureOwnerOnlyParent(this.filePath, false))) return null;
    let metadata: PosixMetadata;
    try {
      metadata = await lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    assertOwnerOnlyFile(metadata);
    if (metadata.size > MAX_STORED_BYTES)
      throw new RelayCredentialStoreError(
        "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      );

    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch {
      throw new RelayCredentialStoreError(
        "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      );
    }
    const parsed = clientCredentialSchema.safeParse(decoded);
    if (!parsed.success)
      throw new RelayCredentialStoreError(
        "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      );
    return parsed.data;
  }

  public async save(credential: RelayCredential): Promise<void> {
    const parsed = clientCredentialSchema.safeParse(credential);
    if (!parsed.success)
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_SCHEMA_INVALID");
    const value = `${JSON.stringify(parsed.data)}\n`;
    if (Buffer.byteLength(value, "utf8") > MAX_STORED_BYTES)
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_SCHEMA_INVALID");

    const directory = dirname(this.filePath);
    await ensureOwnerOnlyParent(this.filePath, true);

    try {
      const existing = await lstat(this.filePath);
      assertOwnerOnlyFile(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async delete(): Promise<void> {
    if (!(await ensureOwnerOnlyParent(this.filePath, false))) return;
    await rm(this.filePath, { force: true });
  }

  public async available(): Promise<boolean> {
    try {
      await this.load();
      return true;
    } catch {
      return false;
    }
  }
}

export function selectRelayCredentialStore(
  paths: PlatformPaths,
  role: "hub" | "client",
): NativeRelayCredentialStore | OwnerOnlyClientRelayCredentialStore {
  if (paths.platform === "linux" && role === "client") {
    return new OwnerOnlyClientRelayCredentialStore(paths.clientCredentialFile);
  }
  return new NativeRelayCredentialStore();
}
