import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_VERSION } from "../src/app/version.js";
import {
  runGatewayCli,
  resolveCodexExecutable,
  type GatewayCliDependencies,
} from "../src/gateway/cli.js";
import { gatewayPaths } from "../src/gateway/paths.js";
import type { PlatformPaths } from "../src/platform/paths.js";
import {
  gatewayConfigSchema,
  gatewayStateSchema,
  readGatewayFile,
  writeGatewayFile,
} from "../src/gateway/storage.js";
import { gatewayStatusSchema } from "../src/gateway/runtime.js";

const roots: string[] = [];
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<{ root: string; paths: PlatformPaths }> {
  const root = await mkdtemp(path.join(tmpdir(), "send-wechat-gateway-cli-"));
  roots.push(root);
  const paths: PlatformPaths = {
    platform: "darwin",
    arch: "arm64",
    username: "alice",
    stateDir: root,
    logDir: path.join(root, "logs"),
    runDir: path.join(root, "run"),
    socketPath: path.join(root, "run", "send-wechat.sock"),
    ipcEndpoint: path.join(root, "run", "send-wechat.sock"),
    stateFile: path.join(root, "state.json"),
    installationFile: path.join(root, "installation.json"),
    idempotencyFile: path.join(root, "idempotency.sqlite3"),
    capabilityFile: path.join(root, "capability"),
    clientCredentialFile: path.join(root, "client-credential.json"),
    tempDir: path.join(root, "tmp"),
    serviceConfigPath: path.join(root, "send-wechat.plist"),
  };
  return { root, paths };
}

function fakeService(running = false) {
  return {
    status: vi.fn(async () => ({ installed: running, running })),
    install: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
  };
}

function output(): {
  stdout: string[];
  stderr: string[];
  emit: (text: string) => void;
  error: (text: string) => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    emit: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
  };
}

describe("gateway CLI", () => {
  it("resolves a real temporary executable from PATH, relative, and absolute paths", async () => {
    const { root } = await fixtureRoot();
    const bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
    const executable = path.join(
      bin,
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    await copyFile(process.execPath, executable);
    const resolved = await realpath(executable);
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      await expect(resolveCodexExecutable("codex")).resolves.toBe(resolved);
      await expect(
        resolveCodexExecutable(path.relative(process.cwd(), executable)),
      ).resolves.toBe(resolved);
      await expect(resolveCodexExecutable(executable)).resolves.toBe(resolved);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("rejects missing and non-executable Codex paths", async () => {
    const { root } = await fixtureRoot();
    const nonExecutable = path.join(root, "codex.txt");
    await writeFile(nonExecutable, "not an executable", { mode: 0o600 });

    await expect(
      resolveCodexExecutable(path.join(root, "missing-codex")),
    ).rejects.toThrow("GATEWAY_CODEX_EXECUTABLE_NOT_FOUND");
    await expect(resolveCodexExecutable(nonExecutable)).rejects.toThrow(
      "GATEWAY_CODEX_EXECUTABLE_NOT_FOUND",
    );
  });

  it("setup saves the resolved config and installs then starts the independent service", async () => {
    const { root, paths } = await fixtureRoot();
    const work = path.join(root, "codex-work");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(work));
    const resolvedWork = await realpath(work);
    const service = fakeService();
    const streams = output();
    const assertHub = vi.fn(async () => undefined);
    const resolveCodex = vi.fn(async () => "/opt/codex/bin/codex");

    await expect(
      runGatewayCli(["setup", "--cwd", work, "--codex", "codex"], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
        assertHub,
        resolveCodex,
      }),
    ).resolves.toBe(0);

    expect(assertHub).toHaveBeenCalledOnce();
    expect(resolveCodex).toHaveBeenCalledWith("codex");
    expect(service.install).toHaveBeenCalledOnce();
    expect(service.start).toHaveBeenCalledOnce();
    expect(service.install.mock.invocationCallOrder[0]).toBeLessThan(
      service.start.mock.invocationCallOrder[0]!,
    );
    const saved = await readGatewayFile(
      gatewayPaths(paths).config,
      gatewayConfigSchema,
    );
    expect(saved).toMatchObject({
      schemaVersion: 1,
      codexExecutable: "/opt/codex/bin/codex",
      workingDirectory: resolvedWork,
    });
    expect(saved?.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await expect(
      runGatewayCli(["setup", "--cwd", work, "--codex", "codex"], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
        assertHub,
        resolveCodex,
      }),
    ).resolves.toBe(0);
    await expect(
      readGatewayFile(gatewayPaths(paths).config, gatewayConfigSchema),
    ).resolves.toMatchObject({ installationId: saved?.installationId });
  });

  it("refuses setup while the service is running without replacing its config", async () => {
    const { root, paths } = await fixtureRoot();
    const work = path.join(root, "codex-work");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(work));
    const savedConfig = {
      schemaVersion: 1 as const,
      installationId: INSTALLATION_ID,
      codexExecutable: "/old/codex",
      workingDirectory: work,
      searchPath: "/old/path",
    };
    await writeGatewayFile(
      gatewayPaths(paths).config,
      gatewayConfigSchema,
      savedConfig,
    );
    const service = fakeService(true);
    const streams = output();

    await expect(
      runGatewayCli(["--json", "setup", "--cwd", work], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
        assertHub: async () => undefined,
        resolveCodex: async () => "/new/codex",
      }),
    ).resolves.toBe(5);

    expect(service.install).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    await expect(
      readGatewayFile(gatewayPaths(paths).config, gatewayConfigSchema),
    ).resolves.toEqual(savedConfig);
  });

  it("rejects setup when the Codex working directory is not a directory", async () => {
    const { root, paths } = await fixtureRoot();
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "file", { mode: 0o600 });
    const service = fakeService();
    const streams = output();

    await expect(
      runGatewayCli(["--json", "setup", "--cwd", file], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
        assertHub: async () => undefined,
        resolveCodex: async () => "/codex",
      }),
    ).resolves.toBe(5);

    expect(JSON.parse(streams.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "GATEWAY_CWD_INVALID" },
    });
    expect(service.status).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });

  it("rejects setup when the saved gateway config is damaged", async () => {
    const { paths } = await fixtureRoot();
    const gateway = gatewayPaths(paths);
    await mkdir(gateway.directory, { recursive: true, mode: 0o700 });
    await writeFile(
      gateway.config,
      JSON.stringify({ schemaVersion: 1, installationId: "damaged" }),
      { mode: 0o600 },
    );
    const service = fakeService();
    const streams = output();

    await expect(
      runGatewayCli(["--json", "setup"], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
        assertHub: async () => undefined,
        resolveCodex: async () => "/codex",
      }),
    ).resolves.toBe(5);

    expect(JSON.parse(streams.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "GATEWAY_STORAGE_INVALID" },
    });
    expect(service.status).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });

  it("rejects non-Hub control without touching the service", async () => {
    const { paths } = await fixtureRoot();
    const service = fakeService();
    const streams = output();
    const assertHub = vi.fn(async () => {
      throw new Error("GATEWAY_REQUIRES_LOCAL_HUB");
    });

    await expect(
      runGatewayCli(["--json", "setup"], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
        assertHub,
        resolveCodex: async () => "/codex",
      }),
    ).resolves.toBe(5);

    expect(assertHub).toHaveBeenCalledOnce();
    expect(service.status).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(JSON.parse(streams.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "GATEWAY_REQUIRES_LOCAL_HUB" },
    });
  });

  it("run loads the saved config and passes the injected abort signal", async () => {
    const { paths } = await fixtureRoot();
    const config = {
      schemaVersion: 1 as const,
      installationId: INSTALLATION_ID,
      codexExecutable: "/codex",
      workingDirectory: "/workspace",
      searchPath: "/custom/bin",
    };
    await writeGatewayFile(
      gatewayPaths(paths).config,
      gatewayConfigSchema,
      config,
    );
    const service = fakeService();
    const signal = new AbortController().signal;
    const run = vi.fn(async (actualConfig, actualPaths, actualSignal) => {
      expect(actualConfig).toEqual(config);
      expect(actualPaths).toBe(paths);
      expect(actualSignal).toBe(signal);
    });

    await expect(
      runGatewayCli(["run"], {
        paths,
        service,
        assertHub: async () => undefined,
        run,
        signal,
      }),
    ).resolves.toBe(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports an unconfigured gateway and a fresh ready heartbeat", async () => {
    const { paths } = await fixtureRoot();
    const service = fakeService();
    const streams = output();

    await expect(
      runGatewayCli(["--json", "status"], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(streams.stdout[0]!)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "status",
      result: {
        configured: false,
        responsive: false,
        threadId: null,
        runtime: null,
      },
    });

    await writeGatewayFile(gatewayPaths(paths).status, gatewayStatusSchema, {
      schemaVersion: 1,
      pid: 42,
      updatedAt: Date.now(),
      phase: "ready",
      threadId: null,
      turnId: null,
      lastError: null,
    });
    await expect(
      runGatewayCli(["--json", "status"], {
        paths,
        service,
        stdout: streams.emit,
        stderr: streams.error,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(streams.stdout[1]!)).toMatchObject({
      result: { configured: false, responsive: true, threadId: null },
    });
  });

  it("reports an expired ready heartbeat as unresponsive", async () => {
    const { paths } = await fixtureRoot();
    const gateway = gatewayPaths(paths);
    await writeGatewayFile(gateway.config, gatewayConfigSchema, {
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      codexExecutable: "/codex",
      workingDirectory: "/workspace",
      searchPath: "/custom/bin",
    });
    await writeGatewayFile(gateway.state, gatewayStateSchema, {
      schemaVersion: 1,
      threadId: "thread-1",
      handled: [],
      pending: [],
      lastError: null,
    });
    await writeGatewayFile(gateway.status, gatewayStatusSchema, {
      schemaVersion: 1,
      pid: 42,
      updatedAt: Date.now() - 16_000,
      phase: "ready",
      threadId: "thread-1",
      turnId: null,
      lastError: null,
    });
    const streams = output();

    await expect(
      runGatewayCli(["--json", "status"], {
        paths,
        service: fakeService(true),
        stdout: streams.emit,
        stderr: streams.error,
      }),
    ).resolves.toBe(0);

    const result = JSON.parse(streams.stdout[0]!) as {
      result: { responsive: boolean; threadId: string | null };
    };
    expect(result.result).toMatchObject({
      responsive: false,
      threadId: "thread-1",
    });
  });

  it("requires Hub authentication and saved config for service install, start, and restart", async () => {
    const { paths } = await fixtureRoot();
    const service = fakeService();
    const streams = output();
    const assertHub = vi.fn(async () => undefined);

    for (const operation of ["install", "start", "restart"] as const) {
      await expect(
        runGatewayCli(["--json", "service", operation], {
          paths,
          service,
          stdout: streams.emit,
          stderr: streams.error,
          assertHub,
        }),
      ).resolves.toBe(5);
    }

    expect(assertHub).toHaveBeenCalledTimes(3);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(streams.stdout.map((text) => JSON.parse(text))).toEqual([
      {
        schemaVersion: 1,
        ok: false,
        error: { code: "GATEWAY_NOT_CONFIGURED" },
      },
      {
        schemaVersion: 1,
        ok: false,
        error: { code: "GATEWAY_NOT_CONFIGURED" },
      },
      {
        schemaVersion: 1,
        ok: false,
        error: { code: "GATEWAY_NOT_CONFIGURED" },
      },
    ]);
  });

  it("loads config before installing, starting, or restarting the service", async () => {
    const { paths } = await fixtureRoot();
    await writeGatewayFile(gatewayPaths(paths).config, gatewayConfigSchema, {
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      codexExecutable: "/codex",
      workingDirectory: "/workspace",
      searchPath: "/custom/bin",
    });
    const service = fakeService();
    const streams = output();
    const assertHub = vi.fn(async () => undefined);

    for (const operation of ["install", "start", "restart"] as const) {
      await expect(
        runGatewayCli(["service", operation], {
          paths,
          service,
          stdout: streams.emit,
          stderr: streams.error,
          assertHub,
        }),
      ).resolves.toBe(0);
    }

    expect(assertHub).toHaveBeenCalledTimes(3);
    expect(service.install).toHaveBeenCalledOnce();
    expect(service.start).toHaveBeenCalledOnce();
    expect(service.restart).toHaveBeenCalledOnce();
  });

  it("allows service stop and uninstall without Hub authentication or config", async () => {
    const { paths } = await fixtureRoot();
    const service = fakeService();
    const streams = output();
    const assertHub = vi.fn(async () => {
      throw new Error("should not be called");
    });

    await expect(
      runGatewayCli(["service", "stop"], {
        paths,
        service,
        assertHub,
        stdout: streams.emit,
        stderr: streams.error,
      }),
    ).resolves.toBe(0);
    await expect(
      runGatewayCli(["service", "uninstall"], {
        paths,
        service,
        assertHub,
        stdout: streams.emit,
        stderr: streams.error,
      }),
    ).resolves.toBe(0);

    expect(assertHub).not.toHaveBeenCalled();
    expect(service.stop).toHaveBeenCalledOnce();
    expect(service.uninstall).toHaveBeenCalledOnce();
  });

  it("renders usage errors as JSON or human-readable stderr", async () => {
    const jsonStreams = output();
    await expect(
      runGatewayCli(["--json", "unknown-command"], {
        stdout: jsonStreams.emit,
        stderr: jsonStreams.error,
      }),
    ).resolves.toBe(2);
    expect(JSON.parse(jsonStreams.stdout[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "USAGE_ERROR" },
    });

    const humanStreams = output();
    await expect(
      runGatewayCli(["unknown-command"], {
        stdout: humanStreams.emit,
        stderr: humanStreams.error,
      }),
    ).resolves.toBe(2);
    expect(humanStreams.stdout).toEqual([]);
    expect(humanStreams.stderr).toEqual([
      "error: unknown command 'unknown-command'\n",
      "USAGE_ERROR\n",
    ]);
  });

  it("renders help without resolving platform paths", async () => {
    const streams = output();
    let pathAccesses = 0;
    const dependencies = {
      get paths(): PlatformPaths {
        pathAccesses += 1;
        throw new Error("paths should not be needed for help");
      },
      stdout: streams.emit,
      stderr: streams.error,
    } satisfies GatewayCliDependencies;

    await expect(runGatewayCli(["--help"], dependencies)).resolves.toBe(0);
    expect(pathAccesses).toBe(0);
    expect(streams.stdout.join("")).toContain("send-wechat-gateway");
  });

  it("renders version without resolving platform paths or service dependencies", async () => {
    const streams = output();
    let pathAccesses = 0;
    const dependencies = {
      get paths(): PlatformPaths {
        pathAccesses += 1;
        throw new Error("paths should not be needed for version");
      },
      get service(): never {
        throw new Error("service should not be needed for version");
      },
      stdout: streams.emit,
      stderr: streams.error,
    } satisfies GatewayCliDependencies;

    await expect(runGatewayCli(["--version"], dependencies)).resolves.toBe(0);
    expect(pathAccesses).toBe(0);
    expect(streams.stdout).toEqual([`${APP_VERSION}\n`]);
    expect(streams.stderr).toEqual([]);
  });
});
