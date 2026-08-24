import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies } from "../src/cli/entry.js";

function harness(overrides: CliDependencies = {}) {
  let stdout = "";
  let stderr = "";
  const io = {
    stdin: Readable.from([]),
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        stdout += String(chunk);
        callback();
      },
    }),
    stderr: new Writable({
      write(chunk, _encoding, callback) {
        stderr += String(chunk);
        callback();
      },
    }),
  };
  return {
    io,
    deps: {
      ...overrides,
      nodeVersion: overrides.nodeVersion ?? "24.0.0",
      io: overrides.io ?? io,
      paths: overrides.paths ?? {
        platform: "darwin",
        arch: "arm64",
        username: "test",
        stateDir: "/tmp/send-wechat-state",
        logDir: "/tmp/send-wechat-log",
        runDir: "/tmp/send-wechat-run",
        socketPath: "/tmp/send-wechat-run/send-wechat.sock",
        ipcEndpoint: "/tmp/send-wechat-run/send-wechat.sock",
        stateFile: "/tmp/send-wechat-state/state.json",
        installationFile: "/tmp/send-wechat-state/installation.json",
        idempotencyFile: "/tmp/send-wechat-state/idempotency.sqlite3",
        capabilityFile: "/tmp/send-wechat-state/capability",
        tempDir: "/tmp/send-wechat-state/tmp",
        serviceConfigPath: "/tmp/send-wechat-service.plist",
      },
      loadCapability: overrides.loadCapability ?? (async () => "a".repeat(64)),
      setup:
        overrides.setup ??
        (async () => ({
          ok: true,
          command: "setup",
          result: {
            role: "hub",
            relayUrl: "https://test.workers.dev",
            state: "ready",
            invitation: "sw1.test",
          },
        })),
      requestIpc:
        overrides.requestIpc ??
        (async () => ({
          ok: true,
          command: "status",
          requestId: "request",
          result: {
            state: "ready",
            boundAt: null,
            lastInboundAt: null,
            renewalDueAt: null,
            expiresAt: null,
          },
        })),
    } satisfies CliDependencies,
    output: () => ({ stdout, stderr }),
  };
}

describe("public CLI", () => {
  it("uses setup as the only onboarding command and rejects an invalid pairing invitation", async () => {
    let sideEffects = 0;
    const fixture = harness({
      requestIpc: async () => {
        sideEffects += 1;
        return { ok: true };
      },
    });

    const code = await runCli(
      ["--json", "setup", "--pair", "not-an-invitation"],
      fixture.deps,
    );

    expect(code).toBe(2);
    expect(sideEffects).toBe(0);
    expect(JSON.parse(fixture.output().stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "setup",
      error: { code: "PAIRING_INVITATION_INVALID", retryable: false },
    });

    const removed = harness();
    await expect(runCli(["--json", "login"], removed.deps)).resolves.toBe(2);
    expect(JSON.parse(removed.output().stdout)).toMatchObject({
      ok: false,
      error: { code: "USAGE_ERROR" },
    });
  });

  it("exposes the package version", async () => {
    const fixture = harness();
    const code = await runCli(["--version"], fixture.deps);
    expect(code).toBe(0);
    expect(fixture.output().stdout).toBe("0.1.0-rc.1\n");
    expect(fixture.output().stderr).toBe("");
  });

  it("emits exactly one schema-versioned JSON status line", async () => {
    const fixture = harness();
    const code = await runCli(["--json", "status"], fixture.deps);
    expect(code).toBe(0);
    expect(fixture.output().stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(fixture.output().stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "status",
    });
  });

  it("routes status and text through the installation-aware dispatcher", async () => {
    const payloads: unknown[] = [];
    const fixture = harness({
      dispatch: async (payload) => {
        payloads.push(payload);
        return payload.command === "status"
          ? { ok: true, command: "status", result: { state: "ready" } }
          : { ok: true, command: "send", result: { state: "accepted" } };
      },
      requestIpc: async () => {
        throw new Error("local IPC should not be used");
      },
    });
    await expect(runCli(["--json", "status"], fixture.deps)).resolves.toBe(0);
    await expect(
      runCli(["--json", "send", "--text", "remote"], fixture.deps),
    ).resolves.toBe(0);
    expect(payloads).toEqual([
      { command: "status" },
      expect.objectContaining({ command: "send_text", text: "remote" }),
    ]);
  });

  it("reports invalid and missing commands in human and JSON modes", async () => {
    const human = harness();
    await expect(runCli(["unknown"], human.deps)).resolves.toBe(2);
    expect(human.output().stdout).toBe("");
    expect(human.output().stderr).toContain("命令用法无效");

    const missing = harness();
    await expect(runCli([], missing.deps)).resolves.toBe(2);
    expect(missing.output().stderr).toContain("命令用法无效");

    const structured = harness();
    await expect(runCli(["--json", "unknown"], structured.deps)).resolves.toBe(
      2,
    );
    expect(JSON.parse(structured.output().stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "send-wechat",
      error: { code: "USAGE_ERROR", retryable: false },
    });
    expect(structured.output().stderr).toBe("");
  });

  it("reads stdin byte-for-byte for send", async () => {
    let request: unknown;
    const fixture = harness({
      io: {
        stdin: Readable.from(["a\n", "b"]),
        stdout: fixturePlaceholder(),
        stderr: fixturePlaceholder(),
      },
      requestIpc: async (options) => {
        request = options;
        return { ok: true, command: "send", result: { state: "accepted" } };
      },
    });
    const code = await runCli(["--json", "send", "--stdin"], fixture.deps);
    expect(code).toBe(0);
    expect((request as { payload: { text: string } }).payload.text).toBe(
      "a\nb",
    );
  });

  it("keeps QR events on stderr while JSON stays one stdout line", async () => {
    const fixture = harness({
      qrRenderer: {
        terminal: () => "QR",
        png: async () => undefined,
      },
      setup: async (_options, onEvent, _onVerifyCode, onAwaitingMessage) => {
        await onEvent({ type: "qr", content: "qr-content" });
        await onEvent({ type: "login_state", state: "wait" });
        await onEvent({ type: "login_state", state: "confirmed" });
        await onAwaitingMessage();
        return { ok: true, command: "setup", state: "awaiting_message" };
      },
    });
    const code = await runCli(["--json", "setup"], fixture.deps);
    expect(code).toBe(0);
    expect(JSON.parse(fixture.output().stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "setup",
    });
    expect(fixture.output().stderr).toContain("QR");
    expect(fixture.output().stderr).toContain("login: wait");
    expect(fixture.output().stderr).toContain(
      "bot 不会回复，收到后 setup 会自动继续",
    );
    expect(
      fixture.output().stderr.match(/bot 不会回复，收到后 setup 会自动继续/g),
    ).toHaveLength(1);
  });

  it("prints the Hub pairing invitation in human setup output", async () => {
    const fixture = harness({
      setup: async () => ({
        ok: true,
        command: "setup",
        result: {
          role: "hub",
          relayUrl: "https://alice.workers.dev",
          state: "ready",
          invitation: "sw1.copy-this-invitation",
        },
      }),
    });
    await expect(runCli(["setup"], fixture.deps)).resolves.toBe(0);
    expect(fixture.output().stdout).toContain("sw1.copy-this-invitation");
    expect(fixture.output().stdout).toContain("10 分钟");
  });

  it("creates a QR file exclusively and refreshes only its own file", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-qr-"));
    const qrFile = join(root, "login.png");
    const fixture = harness({
      randomUUID: () => "refresh",
      setup: async (_options, onEvent) => {
        await onEvent({ type: "qr", content: "first-content" });
        const first = await readFile(qrFile);
        await onEvent({ type: "qr", content: "second-content" });
        const second = await readFile(qrFile);
        expect(second.equals(first)).toBe(false);
        return { ok: true, state: "awaiting_message" };
      },
    });

    const code = await runCli(
      ["--json", "setup", "--qr-file", qrFile],
      fixture.deps,
    );
    expect(code).toBe(0);
    expect((await readFile(qrFile)).subarray(1, 4).toString("ascii")).toBe(
      "PNG",
    );
    if (process.platform !== "win32") {
      expect((await stat(qrFile)).mode & 0o777).toBe(0o600);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("does not overwrite a pre-existing QR path", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-qr-"));
    const qrFile = join(root, "login.png");
    await writeFile(qrFile, "keep");
    const fixture = harness({
      setup: async (_options, onEvent) => {
        await onEvent({ type: "qr", content: "qr-content" });
        return { ok: true, state: "awaiting_message" };
      },
    });

    const code = await runCli(
      ["--json", "setup", "--qr-file", qrFile],
      fixture.deps,
    );
    expect(code).toBe(2);
    await expect(readFile(qrFile, "utf8")).resolves.toBe("keep");
    await rm(root, { recursive: true, force: true });
  });

  it("rejects mutually exclusive send inputs before making an IPC request", async () => {
    let calls = 0;
    const fixture = harness({
      requestIpc: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    const code = await runCli(
      ["--json", "send", "--text", "a", "--stdin"],
      fixture.deps,
    );
    expect(code).toBe(2);
    expect(calls).toBe(0);
    expect(JSON.parse(fixture.output().stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "USAGE_ERROR" },
    });
  });

  it("validates text length in Unicode code points before IPC", async () => {
    let calls = 0;
    const fixture = harness({
      requestIpc: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    const accepted = await runCli(
      ["--json", "send", "--text", "😀".repeat(4000)],
      fixture.deps,
    );
    expect(accepted).toBe(0);
    const rejectedFixture = harness({
      requestIpc: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    const rejected = await runCli(
      ["--json", "send", "--text", "😀".repeat(4001)],
      rejectedFixture.deps,
    );
    expect(rejected).toBe(2);
    expect(calls).toBe(1);
  });

  it("preserves an unknown send result and its idempotency key", async () => {
    const fixture = harness({
      requestIpc: async () => ({
        ok: false,
        command: "send",
        requestId: "request-unknown",
        idempotencyKey: "stable-key",
        error: {
          code: "RESULT_UNKNOWN",
          message: "The send result is unknown.",
          retryable: false,
        },
      }),
    });
    const code = await runCli(
      ["--json", "send", "--text", "hello", "--idempotency-key", "stable-key"],
      fixture.deps,
    );
    expect(code).toBe(4);
    expect(JSON.parse(fixture.output().stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "send",
      requestId: "request-unknown",
      idempotencyKey: "stable-key",
      error: {
        code: "RESULT_UNKNOWN",
        message: "The send result is unknown.",
        retryable: false,
      },
    });
  });

  it("classifies daemon backpressure as a retryable operational result", async () => {
    const fixture = harness({
      requestIpc: async () => ({
        ok: false,
        error: { code: "IPC_BUSY", retryable: true },
      }),
    });
    const code = await runCli(["--json", "status"], fixture.deps);
    expect(code).toBe(4);
    expect(JSON.parse(fixture.output().stdout)).toMatchObject({
      ok: false,
      error: { code: "IPC_BUSY", retryable: true },
    });
  });

  it("reports daemon storage and protocol checks through doctor", async () => {
    let capabilityLoads = 0;
    const fixture = harness({
      serviceManager: {
        status: async () => ({ installed: true, running: true }),
        install: async () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        restart: async () => undefined,
        uninstall: async () => undefined,
      },
      loadCapability: async () => {
        capabilityLoads += 1;
        return "a".repeat(64);
      },
      requestIpc: async () => ({
        ok: true,
        checks: {
          state: "valid",
          idempotencyLedger: "valid",
          credentialStore: "available",
          protocol: "pinned",
        },
      }),
    });
    const code = await runCli(["--json", "doctor"], fixture.deps);
    const result = JSON.parse(fixture.output().stdout) as unknown;
    expect(code).toBe(0);
    expect(capabilityLoads).toBe(1);
    expect(result).toMatchObject({
      checks: {
        state: { ok: true },
        idempotencyLedger: { ok: true },
        credentialStore: { ok: true },
        protocol: { ok: true },
      },
    });
  });

  it("validates regular file metadata and sends its basename", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-cli-"));
    const file = join(root, "message.txt");
    await writeFile(file, "hello");
    let request: RequestIpcCapture | undefined;
    const fixture = harness({
      requestIpc: async (options) => {
        request = options as RequestIpcCapture;
        return { ok: true, command: "send", result: { state: "accepted" } };
      },
    });
    const code = await runCli(["--json", "send", "--file", file], fixture.deps);
    expect(code).toBe(0);
    expect(request?.payload).toMatchObject({
      command: "send_file",
      fileName: "message.txt",
      byteLength: 5,
    });
    expect(request?.filePath).toBe(file);
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "rejects file names containing a foreign-platform separator",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "send-wechat-cli-"));
      const file = join(root, "unsafe\\name.txt");
      await writeFile(file, "hello");
      const fixture = harness();
      await expect(
        runCli(["--json", "send", "--file", file], fixture.deps),
      ).resolves.toBe(2);
      expect(JSON.parse(fixture.output().stdout)).toMatchObject({
        ok: false,
        error: { code: "INVALID_FILE_NAME" },
      });
      await rm(root, { recursive: true, force: true });
    },
  );

  it("prepares capability on service install without starting", async () => {
    const calls: string[] = [];
    const service = {
      status: async () => ({ installed: false, running: false }),
      install: async () => {
        calls.push("install");
      },
      start: async () => {
        calls.push("start");
      },
      stop: async () => {
        calls.push("stop");
      },
      restart: async () => {
        calls.push("restart");
      },
      uninstall: async () => {
        calls.push("uninstall");
      },
    };
    const fixture = harness({
      serviceManager: service,
      prepareOwnerDirectories: async () => {
        calls.push("prepare");
      },
      loadOrCreateCapability: async () => {
        calls.push("capability");
        return "a".repeat(64);
      },
    });
    const code = await runCli(["--json", "service", "install"], fixture.deps);
    expect(code).toBe(0);
    expect(calls).toEqual(["prepare", "capability", "install"]);
  });

  it("cancels reset before checking or changing service state", async () => {
    let statusCalls = 0;
    let resetCalls = 0;
    const fixture = harness({
      promptReset: async () => "no",
      serviceManager: {
        status: async () => {
          statusCalls += 1;
          return { installed: true, running: true };
        },
        install: async () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        restart: async () => undefined,
        uninstall: async () => undefined,
      },
      resetOwnerData: async () => {
        resetCalls += 1;
      },
    });
    const code = await runCli(["--json", "reset"], fixture.deps);
    expect(code).toBe(2);
    expect(statusCalls).toBe(0);
    expect(resetCalls).toBe(0);
  });

  it("rejects runtimes older than Node 24 with a safe error", async () => {
    const fixture = harness({ nodeVersion: "23.9.0" });
    const code = await runCli(["--json", "status"], fixture.deps);
    expect(code).toBe(3);
    expect(JSON.parse(fixture.output().stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "status",
      error: { code: "NODE_VERSION_UNSUPPORTED", retryable: false },
    });
  });
});

type RequestIpcCapture = {
  payload: { command: string; fileName?: string; byteLength?: number };
  filePath?: string;
};

function fixturePlaceholder(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
