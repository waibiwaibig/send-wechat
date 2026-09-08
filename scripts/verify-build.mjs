import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

for (const [name, relativePath] of [
  ["CLI", "../dist/cli/bin.js"],
  ["GATEWAY", "../dist/gateway/bin.js"],
]) {
  const entryPath = fileURLToPath(new URL(relativePath, import.meta.url));
  const contents = await readFile(entryPath, "utf8");
  if (!contents.startsWith("#!/usr/bin/env node\n")) {
    throw new Error(`${name}_BUILD_SHEBANG_INVALID`);
  }
  if (process.platform !== "win32") {
    await access(entryPath, constants.X_OK);
  }
}
