import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { FeishuCli } from "../src/feishu/cli.js";

const require = createRequire(import.meta.url);

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("FeishuCli", () => {
  it("keeps the pinned event consumer contract as NDJSON without --format", () => {
    const packageJson = require.resolve("@larksuite/cli/package.json");
    const binary = join(
      dirname(packageJson),
      "bin",
      `lark-cli${process.platform === "win32" ? ".exe" : ""}`,
    );
    const help = execFileSync(binary, ["event", "consume", "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(help).toContain("Output is one JSON object per line (NDJSON)");
    expect(help).toContain("--as string");
    expect(help).not.toContain("--format");
  });

  it("resolves the bundled native binary and isolates a fresh profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-cli-test-"));
    roots.push(root);
    const cli = new FeishuCli(join(root, "state"));

    await expect(cli.run(["profile", "list"])).resolves.toEqual([]);
    await expect(cli.removeProfile()).resolves.toBeUndefined();
  });

  it("returns a coded, secret-free error for a rejected command", async () => {
    const root = await mkdtemp(join(tmpdir(), "feishu-cli-test-"));
    roots.push(root);
    const cli = new FeishuCli(join(root, "state"));

    await expect(
      cli.run(["command-that-does-not-exist"]),
    ).rejects.toMatchObject({
      name: "FeishuCliError",
      code: expect.stringMatching(/^CLI_/),
    });
  });
});
