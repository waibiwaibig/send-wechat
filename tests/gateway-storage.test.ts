import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  emptyGatewayState,
  gatewayConfigSchema,
  gatewayStateSchema,
  JsonGatewayStateStore,
  readGatewayFile,
  writeGatewayFile,
} from "../src/gateway/storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "send-wechat-gateway-storage-"),
  );
  roots.push(root);
  return root;
}

const config = {
  schemaVersion: 1 as const,
  installationId: "11111111-1111-4111-8111-111111111111",
  codexExecutable: "/opt/codex/bin/codex",
  workingDirectory: "/workspace/project",
  searchPath: "/opt/codex/bin:/usr/bin",
};

describe("gateway storage", () => {
  it("writes and reads owner-only JSON atomically", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "gateway");
    const file = path.join(directory, "config.json");

    await writeGatewayFile(file, gatewayConfigSchema, config);

    await expect(readGatewayFile(file, gatewayConfigSchema)).resolves.toEqual(
      config,
    );
    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(config)}\n`);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).sort()).toEqual(["config.json"]);
  });

  it("fails closed for malformed JSON and schema-incompatible data", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "gateway");
    const file = path.join(directory, "config.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });

    await writeFile(file, "{malformed", "utf8");
    await chmod(file, 0o600);
    await expect(readGatewayFile(file, gatewayConfigSchema)).rejects.toThrow();

    await writeFile(file, JSON.stringify({ schemaVersion: 99 }), "utf8");
    await chmod(file, 0o600);
    await expect(readGatewayFile(file, gatewayConfigSchema)).rejects.toThrow(
      "GATEWAY_STORAGE_INVALID",
    );
  });

  it("rejects symlinked files and world-readable files or directories", async () => {
    const root = await fixtureRoot();
    const directory = path.join(root, "gateway");
    const file = path.join(directory, "config.json");
    const target = path.join(root, "target.json");
    await writeGatewayFile(target, gatewayConfigSchema, config);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await symlink(target, file);

    await expect(readGatewayFile(file, gatewayConfigSchema)).rejects.toThrow(
      "GATEWAY_STORAGE_UNSAFE",
    );
    await expect(
      writeGatewayFile(file, gatewayConfigSchema, config),
    ).rejects.toThrow("GATEWAY_STORAGE_UNSAFE");

    await rm(file);
    await writeGatewayFile(file, gatewayConfigSchema, config);
    await chmod(file, 0o644);
    await expect(readGatewayFile(file, gatewayConfigSchema)).rejects.toThrow(
      "GATEWAY_STORAGE_UNSAFE",
    );

    await chmod(directory, 0o755);
    await expect(readGatewayFile(file, gatewayConfigSchema)).rejects.toThrow(
      "GATEWAY_STORAGE_UNSAFE",
    );
  });

  it("persists pending and handled metadata through JsonGatewayStateStore", async () => {
    const root = await fixtureRoot();
    const file = path.join(root, "gateway", "state.json");
    const store = new JsonGatewayStateStore(file);
    const state = {
      ...emptyGatewayState(),
      threadId: "thread-1",
      handled: ["message-1"],
      pending: ["message-2", "message-3"],
      lastError: "GATEWAY_CODEX_DISCONNECTED",
    };

    await store.save(state);

    await expect(store.load()).resolves.toEqual(state);
    await expect(readGatewayFile(file, gatewayStateSchema)).resolves.toEqual(
      state,
    );
  });
});
