import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../src/app/version.js";

describe("release version", () => {
  it("keeps the daemon protocol version equal to the npm package version", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
      bin: Record<string, string>;
      files: string[];
    };
    expect(APP_VERSION).toBe(packageJson.version);
    expect(packageJson.bin).toStrictEqual({
      "send-wechat": "dist/cli/bin.js",
      "send-wechat-gateway": "dist/gateway/bin.js",
    });
    expect(packageJson.files).toContain("docs/gateway.md");

    const packageLock = JSON.parse(
      await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as {
      packages: Record<string, { bin?: Record<string, string> }>;
    };
    expect(packageLock.packages[""]?.bin).toStrictEqual(packageJson.bin);
  });
});
