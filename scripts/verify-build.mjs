import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const packageJson = require("../package.json");
const expectedLarkCliVersion = packageJson.dependencies?.["@larksuite/cli"];
const repairMessage =
  "Repair with npm ci so the pinned dependency and its native download are restored.";

function failLarkCli(message) {
  throw new Error(
    `LARK_CLI_NATIVE_BINARY_INVALID: ${message}. ${repairMessage}`,
  );
}

if (
  typeof expectedLarkCliVersion !== "string" ||
  !/^\d+\.\d+\.\d+$/.test(expectedLarkCliVersion)
) {
  failLarkCli(
    `package.json must pin @larksuite/cli to an exact semver (found ${String(expectedLarkCliVersion)})`,
  );
}

let larkCliPackagePath;
try {
  larkCliPackagePath = require.resolve("@larksuite/cli/package.json");
} catch {
  failLarkCli("@larksuite/cli/package.json could not be resolved");
}

const larkCliPackage = require(larkCliPackagePath);
if (larkCliPackage.version !== expectedLarkCliVersion) {
  failLarkCli(
    `installed @larksuite/cli version does not match the pinned ${expectedLarkCliVersion} (found ${String(larkCliPackage.version)})`,
  );
}

const larkCliBinary = join(
  dirname(larkCliPackagePath),
  "bin",
  `lark-cli${process.platform === "win32" ? ".exe" : ""}`,
);
try {
  await access(
    larkCliBinary,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
} catch {
  failLarkCli(
    `bundled binary is missing or not executable at ${larkCliBinary}`,
  );
}

let larkCliVersionOutput;
try {
  ({ stdout: larkCliVersionOutput } = await execFileAsync(
    larkCliBinary,
    ["--version"],
    { shell: false, timeout: 10_000, windowsHide: true, encoding: "utf8" },
  ));
} catch {
  failLarkCli("bundled binary could not run with --version");
}
if (
  larkCliVersionOutput.trim() !== `lark-cli version ${expectedLarkCliVersion}`
) {
  failLarkCli(
    `bundled binary --version did not report lark-cli version ${expectedLarkCliVersion}`,
  );
}

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
