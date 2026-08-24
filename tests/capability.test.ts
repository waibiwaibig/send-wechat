import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityError,
  loadCapability,
  loadOrCreateCapability,
} from "../src/ipc/capability.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local IPC capability", () => {
  it("creates one owner-readable random capability and reuses it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "send-wechat-capability-"));
    directories.push(directory);
    const filePath = join(directory, "capability");

    const first = await loadOrCreateCapability(filePath);
    const second = await loadOrCreateCapability(filePath);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    if (process.platform !== "win32")
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a capability readable by other users",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "send-wechat-capability-"),
      );
      directories.push(directory);
      const filePath = join(directory, "capability");
      await loadOrCreateCapability(filePath);
      await chmod(filePath, 0o644);

      await expect(loadOrCreateCapability(filePath)).rejects.toMatchObject({
        code: "CAPABILITY_PERMISSIONS_UNSAFE",
      });
    },
  );

  it("fails closed for missing, symlinked, oversized, and malformed files", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "send-wechat-capability-errors-"),
    );
    directories.push(directory);
    await expect(
      loadCapability(join(directory, "missing")),
    ).rejects.toMatchObject({
      code: "CAPABILITY_NOT_INITIALIZED",
    });

    const target = join(directory, "target");
    const link = join(directory, "link");
    await writeFile(target, `${"a".repeat(64)}\n`, { mode: 0o600 });
    await symlink(target, link);
    await expect(loadCapability(link)).rejects.toMatchObject({
      code: "CAPABILITY_FILE_UNSAFE",
    });

    const oversized = join(directory, "oversized");
    await writeFile(oversized, "x".repeat(129), { mode: 0o600 });
    await expect(loadCapability(oversized)).rejects.toMatchObject({
      code: "CAPABILITY_FORMAT_INVALID",
    });

    const malformed = join(directory, "malformed");
    await writeFile(malformed, "not-a-capability\n", { mode: 0o600 });
    await expect(loadCapability(malformed)).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(loadCapability(malformed)).rejects.toMatchObject({
      code: "CAPABILITY_FORMAT_INVALID",
    });
  });

  it("returns an existing capability and does not replace a directory", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "send-wechat-capability-existing-"),
    );
    directories.push(directory);
    const filePath = join(directory, "capability");
    await writeFile(filePath, `${"b".repeat(64)}\n`, { mode: 0o600 });
    await expect(loadOrCreateCapability(filePath)).resolves.toBe(
      "b".repeat(64),
    );
    expect(await readFile(filePath, "utf8")).toBe(`${"b".repeat(64)}\n`);

    const nested = join(directory, "nested");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested);
    await expect(loadOrCreateCapability(nested)).rejects.toThrow();
  });
});
