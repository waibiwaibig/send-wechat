import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonInstallationStore,
  type InstallationState,
} from "../src/storage/installation-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local installation role state", () => {
  it("round-trips strict Hub and remote-client metadata owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-installation-"));
    directories.push(root);
    const file = join(root, "nested", "installation.json");
    const store = new JsonInstallationStore(file);
    const hub: InstallationState = {
      schemaVersion: 1,
      role: "hub",
      relayUrl: "https://owner.workers.dev",
      workerName: "send-wechat-relay",
      accountId: "0123456789abcdef0123456789abcdef",
    };
    await store.save(hub);
    await expect(store.load()).resolves.toEqual(hub);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    const client: InstallationState = {
      schemaVersion: 1,
      role: "client",
      relayUrl: "https://owner.workers.dev",
      deviceId: Buffer.alloc(16, 7).toString("base64url"),
    };
    await store.save(client);
    await expect(store.load()).resolves.toEqual(client);
    await store.delete();
    await expect(store.load()).resolves.toBeNull();
  });

  it("rejects unknown schemas, fields, roles, and unsafe permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-installation-"));
    directories.push(root);
    const file = join(root, "installation.json");
    const invalidValues = [
      { schemaVersion: 2, role: "hub" },
      {
        schemaVersion: 1,
        role: "hub",
        relayUrl: "http://owner.workers.dev",
        workerName: "send-wechat-relay",
      },
      {
        schemaVersion: 1,
        role: "client",
        relayUrl: "https://owner.workers.dev",
        deviceId: "short",
        extra: true,
      },
    ];
    for (const value of invalidValues) {
      await writeFile(file, JSON.stringify(value), { mode: 0o600 });
      await expect(
        new JsonInstallationStore(file).load(),
      ).rejects.toMatchObject({ code: "INSTALLATION_SCHEMA_INCOMPATIBLE" });
    }
    if (process.platform !== "win32") {
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          role: "hub",
          relayUrl: "https://owner.workers.dev",
          workerName: "send-wechat-relay",
          accountId: "0123456789abcdef0123456789abcdef",
        }),
        { mode: 0o644 },
      );
      await chmod(file, 0o644);
      await expect(
        new JsonInstallationStore(file).load(),
      ).rejects.toMatchObject({ code: "INSTALLATION_PERMISSIONS_UNSAFE" });
    }
  });
});
