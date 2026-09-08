import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  for (const relativePath of ["../dist/cli/bin.js", "../dist/gateway/bin.js"]) {
    await chmod(fileURLToPath(new URL(relativePath, import.meta.url)), 0o755);
  }
}
