import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FeishuCli } from "../src/feishu/cli.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("FeishuCli", () => {
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
