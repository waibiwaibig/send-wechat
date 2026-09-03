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
  const installation =
    dependencies.credentialStore === undefined ||
    dependencies.relayCredentialStore === undefined
      ? await new JsonInstallationStore(paths.installationFile).load()
      : undefined;
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
