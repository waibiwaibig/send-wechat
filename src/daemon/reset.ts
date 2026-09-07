import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { NativeCredentialStore } from "../storage/credential-store.js";
import { selectRelayCredentialStore } from "../storage/client-relay-credential-store.js";
import { JsonInstallationStore } from "../storage/installation-store.js";
import type { PlatformPaths } from "../platform/paths.js";

export type ResetDependencies = {
  readonly credentialStore?: { delete(): Promise<void> };
  readonly relayCredentialStore?: { delete(): Promise<void> };
};

export class LocalClientResetError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "LocalClientResetError";
  }
}

export async function assertLocalClientResetAllowed(
  paths: PlatformPaths,
): Promise<void> {
  let installation = null;
  try {
    installation = await new JsonInstallationStore(
      paths.installationFile,
    ).load();
  } catch (error) {
    // A non-directory state root cannot contain an installation file. Keep
    // the established reset behavior for that isolated filesystem failure;
    // malformed or unreadable installation files still propagate below.
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
  }
  if (installation?.role === "hub")
    throw new LocalClientResetError("RESET_LOCAL_HUB_STATE");
  if (
    (await pathExists(paths.stateFile)) ||
    (await pathExists(paths.idempotencyFile))
  )
    throw new LocalClientResetError("RESET_LOCAL_HUB_STATE");
}

/**
 * Remove only state owned by a remote client.
 *
 * A local reset is deliberately conservative: a Hub installation, state
 * document, or idempotency ledger is evidence that this account may own the
 * Weixin binding, so the operation stops before deleting anything. The
 * service lifecycle is controlled by the CLI context; this function only
 * removes the client installation, its file credential, and a stale IPC
 * capability.
 */
export async function resetLocalClientData(
  paths: PlatformPaths,
): Promise<void> {
  await assertLocalClientResetAllowed(paths);

  try {
    await unlinkOwnedPath(paths.clientCredentialFile);
    await unlinkOwnedPath(paths.installationFile);
    await unlinkOwnedPath(paths.capabilityFile);
  } catch (error) {
    throw new LocalClientResetError(
      error instanceof LocalClientResetError
        ? error.code
        : "RESET_LOCAL_CLEANUP_FAILED",
    );
  }
}

/**
 * Remove all owner state without touching the platform service definition.
 *
 * The reset boundary is deliberately implemented here rather than through the
 * running daemon: callers stop the service first, then this function removes
 * credentials and owner-only files. Directory traversal uses lstat, so a
 * symlink is unlinked rather than followed.
 */
export async function resetOwnerData(
  paths: PlatformPaths,
  dependencies: ResetDependencies = {},
): Promise<void> {
  // Always inspect the installation role before selecting a credential
  // backend. A valid client must never cause reset to touch the native
  // keyring, even when callers inject both dependency ports.
  let installation = null;
  try {
    installation = await new JsonInstallationStore(
      paths.installationFile,
    ).load();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
  }
  const credentialStore =
    installation?.role === "client"
      ? { delete: () => Promise.resolve() }
      : (dependencies.credentialStore ?? new NativeCredentialStore());
  let relayCredentialStore = dependencies.relayCredentialStore;
  if (relayCredentialStore === undefined) {
    relayCredentialStore = selectRelayCredentialStore(
      paths,
      installation?.role === "client" ? "client" : "hub",
    );
  }
  const credentialDeletion = await Promise.allSettled([
    credentialStore.delete(),
    relayCredentialStore.delete(),
  ]);
  const failure = credentialDeletion.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;

  const preservedPath = resolve(paths.serviceConfigPath);
  await emptyDirectory(paths.stateDir, preservedPath);
  await emptyDirectory(paths.logDir, preservedPath);
  await emptyDirectory(paths.runDir, preservedPath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkOwnedPath(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink())
      throw new LocalClientResetError("RESET_LOCAL_CLEANUP_FAILED");
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function emptyDirectory(
  directory: string,
  preservedPath: string,
): Promise<void> {
  try {
    const rootMetadata = await lstat(directory);
    if (rootMetadata.isSymbolicLink()) {
      await unlink(directory);
      return;
    }
    if (!rootMetadata.isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (resolve(entryPath) === preservedPath) continue;
    const metadata = await lstat(entryPath);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await emptyDirectory(entryPath, preservedPath);
      const resolvedEntryPath = resolve(entryPath);
      if (
        preservedPath !== resolvedEntryPath &&
        !preservedPath.startsWith(`${resolvedEntryPath}${sep}`)
      ) {
        await rmdir(entryPath);
      }
    } else {
      // Symlinks are intentionally handled as files: never follow them.
      await unlink(entryPath);
    }
  }
}
