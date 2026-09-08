import { rename } from "node:fs/promises";

import pRetry from "p-retry";

const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

function isWindowsTransientRenameError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && WINDOWS_TRANSIENT_RENAME_ERRORS.has(code);
}

export async function renameFile(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32") {
    await rename(from, to);
    return;
  }

  await pRetry(() => rename(from, to), {
    retries: 10,
    minTimeout: 10,
    maxTimeout: 100,
    maxRetryTime: 1000,
    shouldRetry: ({ error }) => isWindowsTransientRenameError(error),
  });
}
