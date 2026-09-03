import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { CliContext, createContext } from "../src/cli/context.js";
import type { CliIO } from "../src/cli/contracts.js";
import type { PlatformPaths } from "../src/platform/paths.js";

const fixturePaths: PlatformPaths = {
  platform: "darwin",
  arch: "arm64",
  username: "test",
  stateDir: "/tmp/send-wechat-context-state",
  logDir: "/tmp/send-wechat-context-log",
  runDir: "/tmp/send-wechat-context-run",
  socketPath: "/tmp/send-wechat-context-run/send-wechat.sock",
  ipcEndpoint: "/tmp/send-wechat-context-run/send-wechat.sock",
  stateFile: "/tmp/send-wechat-context-state/state.json",
  installationFile: "/tmp/send-wechat-context-state/installation.json",
  idempotencyFile: "/tmp/send-wechat-context-state/idempotency.sqlite3",
  capabilityFile: "/tmp/send-wechat-context-state/capability",
  clientCredentialFile: "/tmp/send-wechat-context-state/client-credential.json",
  tempDir: "/tmp/send-wechat-context-state/tmp",
  serviceConfigPath: "/tmp/send-wechat-context.plist",
};

function io(input: Readable = Readable.from([])): {
  value: CliIO;
  stdout(): string;
  stderr(): string;
} {
  let stdout = "";
  let stderr = "";
  const output = (append: (value: string) => void): Writable =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  return {
    value: {
      stdin: input,
      stdout: output((value) => {
        stdout += value;
      }),
      stderr: output((value) => {
        stderr += value;
      }),
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("CLI context adapters", () => {
  it("uses injected platform, service, capability, IPC, and request identity", async () => {
    const output = io();
    const calls: string[] = [];
    const service = {
      status: async () => ({ installed: true, running: true }),
      install: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
      uninstall: async () => undefined,
    };
    const context = new CliContext({
      io: output.value,
      nodeVersion: "24.2.0",
      randomUUID: () => "request-id",
      currentPlatformPaths: () => fixturePaths,
      currentSupportedPlatform: () => "darwin",
      serviceManager: service,
      loadCapability: async () => {
        calls.push("capability");
        return "a".repeat(64);
      },
      requestIpc: async (options) => {
        calls.push(options.capability);
        return { ok: true, command: "status" };
      },
    });

    expect(context.output()).toBe(output.value);
    expect(context.nodeVersion()).toBe("24.2.0");
    expect(context.randomUUID()).toBe("request-id");
    expect(context.getPaths()).toBe(fixturePaths);
    expect(context.getPaths()).toBe(fixturePaths);
    expect(context.getPlatform()).toBe("darwin");
    expect(context.getPlatform()).toBe("darwin");
    expect(context.getServiceManager()).toBe(service);
    expect(context.getServiceManager()).toBe(service);
    await expect(context.capability()).resolves.toBe("a".repeat(64));
    await expect(
      context.ipc(
        { command: "status" },
        undefined,
        undefined,
        undefined,
        "known-capability",
      ),
    ).resolves.toEqual({
      ok: true,
      command: "status",
      requestId: "request-id",
    });
    expect(calls).toEqual(["capability", "known-capability"]);
  });

  it("bounds stdin and keeps non-interactive prompts fail closed", async () => {
    const readable = Readable.from(["hello", " 世界"]);
    const output = io(readable);
    const context = new CliContext({ io: output.value });
    await expect(context.readStdin()).resolves.toBe("hello 世界");
    await expect(context.verifyCode()).resolves.toBeNull();
    await expect(context.confirmReset()).resolves.toBeNull();

    const oversized = new CliContext({
      io: io(Readable.from(["x".repeat(16_001)])).value,
    });
    await expect(oversized.readStdin()).rejects.toMatchObject({
      code: "INVALID_TEXT",
    });
  });

  it("routes prompts, QR rendering, install preparation, reset, and daemon startup", async () => {
    const output = io();
    const calls: string[] = [];
    const context = new CliContext({
      io: output.value,
      paths: fixturePaths,
      currentSupportedPlatform: () => "darwin",
      promptVerifyCode: async () => "123456",
      promptReset: async () => "RESET",
      qrRenderer: {
        terminal: (content) => `terminal:${content}`,
        png: async (path, content) => {
          calls.push(`png:${path}:${content}`);
        },
      },
      prepareOwnerDirectories: async () => {
        calls.push("prepare");
      },
      loadOrCreateCapability: async () => {
        calls.push("create-capability");
        return "b".repeat(64);
      },
      resetOwnerData: async () => {
        calls.push("reset");
      },
      runProductionDaemon: async () => {
        calls.push("daemon");
      },
    });

    context.setLanguage("en");
    await expect(context.verifyCode()).resolves.toBe("123456");
    await expect(context.confirmReset()).resolves.toBe("RESET");
    await context.renderQr("content", undefined);
    await context.renderQr("content", "/tmp/login.png");
    await context.emitLoginState("wait");
    await context.prepareInstall();
    await context.reset();
    await context.runDaemon();

    expect(output.stderr()).toContain("terminal:content");
    expect(output.stderr()).toContain("login: wait");
    expect(calls).toEqual([
      "png:/tmp/login.png:content",
      "prepare",
      "create-capability",
      "reset",
      "daemon",
    ]);
  });

  it("can construct the real lazy process adapters without executing them", () => {
    const context = createContext({ paths: fixturePaths });
    expect(context).toBeInstanceOf(CliContext);
    expect(context.output().stdin).toBe(process.stdin);
    expect(context.nodeVersion()).toBe(process.versions.node);
    expect(context.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.getPlatform()).toBe("darwin");
    expect(context.getServiceManager()).toBe(context.getServiceManager());
  });

  it("points generated service definitions at the dedicated CLI launcher", () => {
    let cliEntry = "";
    const service = {
      status: async () => ({ installed: true, running: true }),
      install: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
      uninstall: async () => undefined,
    };
    const context = createContext({
      paths: fixturePaths,
      createServiceManager: (dependencies) => {
        cliEntry = dependencies.cliEntry;
        return service;
      },
    });
    expect(context.getServiceManager()).toBe(service);
    expect(cliEntry).toMatch(/[/\\]dist[/\\]cli[/\\]bin\.js$/);
  });

  it("renders a terminal QR code with the production renderer", async () => {
    const output = io();
    const context = new CliContext({ io: output.value, paths: fixturePaths });
    await context.renderQr("https://example.com/weixin-login", undefined);
    expect(output.stderr()).toContain("\u001b[");
  });
});
