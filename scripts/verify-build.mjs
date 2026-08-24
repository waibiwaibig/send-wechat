import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli/bin.js", import.meta.url));
const contents = await readFile(cliPath, "utf8");

if (!contents.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("CLI_BUILD_SHEBANG_INVALID");
}

if (process.platform !== "win32") {
  await access(cliPath, constants.X_OK);
}
