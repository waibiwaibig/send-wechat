import {
  chmod,
  lstat,
  mkdir,
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
  OwnerOnlyClientRelayCredentialStore,
  selectRelayCredentialStore,
} from "../src/storage/client-relay-credential-store.js";
import type { PlatformPaths } from "../src/platform/paths.js";

const roots: string[] = [];

const clientCredential = {
  schemaVersion: 1 as const,
  role: "client" as const,
  deviceId: Buffer.alloc(16, 1).toString("base64url"),
  deviceKey: Buffer.alloc(32, 2).toString("base64url"),
};

const hubCredential = {
  schemaVersion: 1 as const,
  role: "hub" as const,
  hubAuthToken: Buffer.alloc(32, 3).toString("base64url"),
  devices: [],
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "send-wechat-client-credential-"));
  roots.push(root);
  return join(root, "state", "client-credential.json");
}

describe("owner-only Linux client relay credential store", () => {
  it.skipIf(process.platform === "win32")(
    "round-trips a client credential with owner-only parent and file modes",
    async () => {
      const filePath = await fixturePath();
      const store = new OwnerOnlyClientRelayCredentialStore(filePath);

      await store.save(clientCredential);

      await expect(store.load()).resolves.toEqual(clientCredential);
      await expect(stat(join(filePath, ".."))).resolves.toMatchObject({
        mode: expect.any(Number),
      });
      expect((await stat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      await expect(readFile(filePath, "utf8")).resolves.toContain(
        '"role":"client"',
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed for Hub records, malformed data, oversized data, and unsafe modes",
    async () => {
      const filePath = await fixturePath();
      const store = new OwnerOnlyClientRelayCredentialStore(filePath);

      await expect(store.save(hubCredential as never)).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_SCHEMA_INVALID",
      });

      await mkdir(join(filePath, ".."), { recursive: true, mode: 0o700 });
      await writeFile(filePath, JSON.stringify(hubCredential), { mode: 0o600 });
      await expect(store.load()).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      });

      await writeFile(filePath, "{".repeat(64 * 1024), { mode: 0o600 });
      await expect(store.load()).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      });

      await writeFile(filePath, JSON.stringify(clientCredential), {
        mode: 0o640,
      });
      await chmod(filePath, 0o640);
      await expect(store.load()).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE",
      });

      await chmod(filePath, 0o600);
      await chmod(join(filePath, ".."), 0o750);
      await expect(store.load()).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE",
      });
      await expect(store.save(clientCredential)).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked credential parent directory",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "send-wechat-client-credential-parent-"),
      );
      roots.push(root);
      const outside = join(root, "outside");
      const linkedParent = join(root, "state");
      const filePath = join(linkedParent, "client-credential.json");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(
        join(outside, "client-credential.json"),
        JSON.stringify(clientCredential),
        { mode: 0o600 },
      );
      await symlink(outside, linkedParent);
      const store = new OwnerOnlyClientRelayCredentialStore(filePath);

      await expect(store.load()).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE",
      });
      await expect(store.save(clientCredential)).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlinked credential paths and removes only the link on delete",
    async () => {
      const filePath = await fixturePath();
      const outsidePath = join(filePath, "..", "outside.json");
      await mkdir(join(filePath, ".."), { recursive: true, mode: 0o700 });
      await writeFile(outsidePath, JSON.stringify(clientCredential), {
        mode: 0o600,
      });
      await symlink(outsidePath, filePath);
      const store = new OwnerOnlyClientRelayCredentialStore(filePath);

      await expect(store.load()).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE",
      });
      await expect(store.save(clientCredential)).rejects.toMatchObject({
        code: "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE",
      });
      await store.delete();
      await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(outsidePath, "utf8")).resolves.toContain(
        '"role":"client"',
      );
    },
  );

  it("selects the file store only for Linux clients and native storage everywhere else", () => {
    const paths = (platform: PlatformPaths["platform"]): PlatformPaths => ({
      platform,
      arch: "x64",
      username: "alice",
      stateDir: "/home/alice/.local/state/send-wechat",
      logDir: "/home/alice/.local/state/send-wechat/logs",
      runDir: "/home/alice/.local/state/send-wechat/run",
      socketPath: "/home/alice/.local/state/send-wechat/run/send-wechat.sock",
      ipcEndpoint: "/home/alice/.local/state/send-wechat/run/send-wechat.sock",
      stateFile: "/home/alice/.local/state/send-wechat/state.json",
      installationFile:
        "/home/alice/.local/state/send-wechat/installation.json",
      idempotencyFile:
        "/home/alice/.local/state/send-wechat/idempotency.sqlite3",
      capabilityFile: "/home/alice/.local/state/send-wechat/capability",
      clientCredentialFile:
        "/home/alice/.local/state/send-wechat/client-credential.json",
      tempDir: "/home/alice/.local/state/send-wechat/tmp",
      serviceConfigPath: "/home/alice/.config/systemd/user/send-wechat.service",
    });

    expect(selectRelayCredentialStore(paths("linux"), "client")).toBeInstanceOf(
      OwnerOnlyClientRelayCredentialStore,
    );
    expect(
      selectRelayCredentialStore(paths("linux"), "hub").constructor.name,
    ).toBe("NativeRelayCredentialStore");
    expect(
      selectRelayCredentialStore(paths("darwin"), "client").constructor.name,
    ).toBe("NativeRelayCredentialStore");
  });
});
