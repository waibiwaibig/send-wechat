import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IpcServer, requestIpc } from "../src/ipc/transport.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  directory: string;
  endpoint: string;
  tempDir: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "send-wechat-ipc-test-"));
  directories.push(directory);
  return {
    directory,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\send-wechat-test-${process.pid}-${Date.now()}`
        : join(directory, "daemon.sock"),
    tempDir: join(directory, "staged"),
  };
}

describe("length-prefixed local IPC interface", () => {
  it("streams daemon events and verify-code input without leaking callback failures", async () => {
    const paths = await fixture();
    const server = new IpcServer({
      endpoint: paths.endpoint,
      tempDir: paths.tempDir,
      capability: "e".repeat(64),
      appVersion: "1.2.3",
      async handle(_request, context) {
        await context.emit({ type: "login_state", state: "wait" });
        const code = await context.requestVerifyCode();
        return { ok: true, code };
      },
    });
    await server.start();
    const events: unknown[] = [];
    try {
      await expect(
        requestIpc({
          endpoint: paths.endpoint,
          capability: "e".repeat(64),
          appVersion: "1.2.3",
          requestId: "request-event",
          payload: { command: "login" },
          onEvent: async (event) => {
            events.push(event);
          },
          onVerifyCode: async () => "1234",
        }),
      ).resolves.toEqual({ ok: true, code: "1234" });
      expect(events).toEqual([{ type: "login_state", state: "wait" }]);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid request combinations and unavailable endpoints before network use", async () => {
    const paths = await fixture();
    await expect(
      requestIpc({
        endpoint: paths.endpoint,
        capability: "f".repeat(64),
        appVersion: "1.2.3",
        requestId: "missing-file",
        payload: {
          command: "send_file",
          idempotencyKey: "key",
          fileName: "x.txt",
          byteLength: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "FILE_REQUIRED" });
    await expect(
      requestIpc({
        endpoint: paths.endpoint,
        capability: "f".repeat(64),
        appVersion: "1.2.3",
        requestId: "unexpected-file",
        payload: { command: "status" },
        filePath: join(paths.directory, "not-used"),
      }),
    ).rejects.toMatchObject({ code: "FILE_UNEXPECTED" });
    await expect(
      requestIpc({
        endpoint: paths.endpoint,
        capability: "f".repeat(64),
        appVersion: "1.2.3",
        requestId: "unavailable",
        payload: { command: "status" },
      }),
    ).rejects.toMatchObject({ code: "IPC_UNAVAILABLE" });
  });

  it("turns an unexpected daemon handler failure into a redacted local failure", async () => {
    const paths = await fixture();
    const server = new IpcServer({
      endpoint: paths.endpoint,
      tempDir: paths.tempDir,
      capability: "g".repeat(64),
      appVersion: "1.2.3",
      async handle() {
        throw new Error("secret filesystem path");
      },
    });
    await server.start();
    try {
      await expect(
        requestIpc({
          endpoint: paths.endpoint,
          capability: "g".repeat(64),
          appVersion: "1.2.3",
          requestId: "handler-error",
          payload: { command: "status" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "LOCAL_FAILURE", retryable: false },
      });
    } finally {
      await server.close();
    }
  });

  it("streams a file to an owner-controlled staging path without exposing the source path", async () => {
    const paths = await fixture();
    const sourcePath = join(paths.directory, "private report.txt");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(sourcePath, "hello", { mode: 0o600 }),
    );
    let stagedPath: string | null = null;
    const server = new IpcServer({
      endpoint: paths.endpoint,
      tempDir: paths.tempDir,
      capability: "a".repeat(64),
      appVersion: "1.2.3",
      async handle(request) {
        expect(request).toMatchObject({
          command: "send_file",
          requestId: "request-1",
          idempotencyKey: "job-1",
          fileName: "report.txt",
          byteLength: 5,
          contentSha256:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        });
        expect(JSON.stringify(request)).not.toContain(sourcePath);
        if (request.command !== "send_file")
          throw new Error("unexpected command");
        stagedPath = request.stagedPath;
        expect(await readFile(request.stagedPath, "utf8")).toBe("hello");
        return { ok: true, state: "accepted" };
      },
    });
    await server.start();

    try {
      const result = await requestIpc({
        endpoint: paths.endpoint,
        capability: "a".repeat(64),
        appVersion: "1.2.3",
        requestId: "request-1",
        payload: {
          command: "send_file",
          idempotencyKey: "job-1",
          fileName: "report.txt",
          byteLength: 5,
        },
        filePath: sourcePath,
      });
      expect(result).toEqual({ ok: true, state: "accepted" });
      expect(stagedPath).not.toBeNull();
      await server.close();
      expect(await readdir(paths.tempDir)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects capability and exact-version mismatches before dispatch", async () => {
    const paths = await fixture();
    let dispatches = 0;
    const server = new IpcServer({
      endpoint: paths.endpoint,
      tempDir: paths.tempDir,
      capability: "b".repeat(64),
      appVersion: "1.2.3",
      async handle() {
        dispatches += 1;
        return { ok: true };
      },
    });
    await server.start();

    try {
      await expect(
        requestIpc({
          endpoint: paths.endpoint,
          capability: "c".repeat(64),
          appVersion: "1.2.3",
          requestId: "request-auth",
          payload: { command: "status" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "IPC_UNAUTHORIZED", retryable: false },
      });
      await expect(
        requestIpc({
          endpoint: paths.endpoint,
          capability: "b".repeat(64),
          appVersion: "9.9.9",
          requestId: "request-version",
          payload: { command: "status" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "VERSION_MISMATCH", retryable: false },
      });
      expect(dispatches).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a file before streaming when daemon staging capacity is exhausted", async () => {
    const paths = await fixture();
    const sourcePath = join(paths.directory, "five.txt");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(sourcePath, "hello"),
    );
    const server = new IpcServer({
      endpoint: paths.endpoint,
      tempDir: paths.tempDir,
      capability: "d".repeat(64),
      appVersion: "1.2.3",
      maximumStagedBytes: 4,
      async handle() {
        throw new Error("must not dispatch");
      },
    });
    await server.start();

    try {
      await expect(
        requestIpc({
          endpoint: paths.endpoint,
          capability: "d".repeat(64),
          appVersion: "1.2.3",
          requestId: "request-busy",
          payload: {
            command: "send_file",
            idempotencyKey: "busy",
            fileName: "five.txt",
            byteLength: 5,
          },
          filePath: sourcePath,
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "IPC_BUSY", retryable: true },
      });
    } finally {
      await server.close();
    }
  });
});
