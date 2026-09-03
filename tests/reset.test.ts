import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resetOwnerData } from "../src/daemon/reset.js";
import type { PlatformPaths } from "../src/platform/paths.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function paths(root: string): PlatformPaths {
  return {
    platform: "darwin",
    arch: "arm64",
    username: "test",
    stateDir: join(root, "state"),
    logDir: join(root, "logs"),
    runDir: join(root, "run"),
    socketPath: join(root, "run", "send-wechat.sock"),
    ipcEndpoint: join(root, "run", "send-wechat.sock"),
    stateFile: join(root, "state", "state.json"),
    installationFile: join(root, "state", "installation.json"),
    idempotencyFile: join(root, "state", "idempotency.sqlite3"),
    capabilityFile: join(root, "state", "capability"),
    clientCredentialFile: join(root, "state", "client-credential.json"),
    tempDir: join(root, "state", "tmp"),
    serviceConfigPath: join(root, "service.plist"),
  };
}

describe("owner reset", () => {
  it("deletes binding and data without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-reset-"));
    roots.push(root);
    const fixture = paths(root);
    await mkdir(fixture.stateDir, { recursive: true });
    await mkdir(fixture.logDir, { recursive: true });
    await mkdir(fixture.runDir, { recursive: true });
    await writeFile(fixture.stateFile, "state");
    await writeFile(fixture.idempotencyFile, "ledger");
    await writeFile(fixture.serviceConfigPath, "service");
    const outside = join(root, "outside");
    await writeFile(outside, "keep");
    await symlink(outside, join(fixture.stateDir, "outside-link"));

    let deleted = 0;
    await resetOwnerData(fixture, {
      credentialStore: {
        delete: async () => {
          deleted += 1;
        },
      },
      relayCredentialStore: {
        delete: async () => {
          deleted += 1;
        },
      },
    });

    expect(deleted).toBe(2);
    await expect(readFile(fixture.serviceConfigPath, "utf8")).resolves.toBe(
      "service",
    );
    await expect(readFile(outside, "utf8")).resolves.toBe("keep");
    await expect(
      readFile(fixture.idempotencyFile, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(fixture.stateDir, "outside-link")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a service configuration located inside stateDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-reset-"));
    roots.push(root);
    const base = paths(root);
    const fixture = {
      ...base,
      serviceConfigPath: join(base.stateDir, "service.ps1"),
    };
    await mkdir(fixture.stateDir, { recursive: true });
    await writeFile(fixture.serviceConfigPath, "service");
    await resetOwnerData(fixture, {
      credentialStore: { delete: async () => undefined },
      relayCredentialStore: { delete: async () => undefined },
    });
    await expect(readFile(fixture.serviceConfigPath, "utf8")).resolves.toBe(
      "service",
    );
  });

  it("unlinks a symlinked reset root without recreating or following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-reset-"));
    roots.push(root);
    const fixture = paths(root);
    const outside = join(root, "outside-directory");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "outside");
    await symlink(outside, fixture.stateDir);

    await resetOwnerData(fixture, {
      credentialStore: { delete: async () => undefined },
      relayCredentialStore: { delete: async () => undefined },
    });

    await expect(lstat(fixture.stateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(outside, "keep"), "utf8")).resolves.toBe(
      "outside",
    );
  });

  it("removes nested directories, preserves descendants of the service path, and tolerates absent roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-reset-nested-"));
    roots.push(root);
    const fixture = paths(root);
    await mkdir(fixture.stateDir, { recursive: true });
    const nested = join(fixture.stateDir, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "remove-me"), "remove");
    const serviceDirectory = join(fixture.stateDir, "service");
    await mkdir(join(serviceDirectory, "sub"), { recursive: true });
    const serviceFile = join(serviceDirectory, "sub", "service.ps1");
    const preservedFixture = { ...fixture, serviceConfigPath: serviceFile };
    await writeFile(serviceFile, "preserve");
    await resetOwnerData(preservedFixture, {
      credentialStore: { delete: async () => undefined },
      relayCredentialStore: { delete: async () => undefined },
    });
    await expect(readFile(serviceFile, "utf8")).resolves.toBe("preserve");
    await expect(lstat(nested)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.logDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not touch non-directory roots and propagates credential failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-reset-errors-"));
    roots.push(root);
    const fixture = paths(root);
    await writeFile(fixture.stateDir, "not a directory");
    await resetOwnerData(fixture, {
      credentialStore: { delete: async () => undefined },
      relayCredentialStore: { delete: async () => undefined },
    });
    await expect(readFile(fixture.stateDir, "utf8")).resolves.toBe(
      "not a directory",
    );
    await expect(
      resetOwnerData(fixture, {
        credentialStore: {
          delete: async () => {
            throw new Error("keychain");
          },
        },
        relayCredentialStore: { delete: async () => undefined },
      }),
    ).rejects.toThrow("keychain");
  });

  it.skipIf(process.platform === "win32")(
    "deletes a Linux client's file credential without requiring a keyring",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "send-wechat-reset-client-"));
      roots.push(root);
      const fixture = {
        ...paths(root),
        platform: "linux" as const,
        clientCredentialFile: join(root, "state", "client-credential.json"),
      };
      await mkdir(fixture.stateDir, { recursive: true, mode: 0o700 });
      await writeFile(
        fixture.installationFile,
        JSON.stringify({
          schemaVersion: 1,
          role: "client",
          relayUrl: "https://relay.workers.dev",
          deviceId: Buffer.alloc(16, 1).toString("base64url"),
        }),
        { mode: 0o600 },
      );
      await writeFile(fixture.clientCredentialFile, "client", { mode: 0o600 });

      let keyringDeletes = 0;
      await resetOwnerData(fixture, {
        credentialStore: {
          delete: async () => {
            keyringDeletes += 1;
            throw new Error("headless keyring unavailable");
          },
        },
      });

      expect(keyringDeletes).toBe(0);
      await expect(lstat(fixture.clientCredentialFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
