import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  await chmod(
    fileURLToPath(new URL("../dist/cli/bin.js", import.meta.url)),
    0o755,
  );
}
