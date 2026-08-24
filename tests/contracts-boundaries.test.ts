import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { IpcTransportError } from "../src/ipc/transport.js";
import {
  CliFailure,
  classifyExitCode,
  codeFromError,
  ensureNodeVersion,
  failure,
  isRecord,
  localizedMessage,
  normalizeFinal,
  safeCode,
  writeOutput,
} from "../src/cli/contracts.js";

describe("CLI contract boundaries", () => {
  it("accepts records and rejects arrays, null, and invalid error codes", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(safeCode("VALID_CODE_1")).toBe("VALID_CODE_1");
    expect(safeCode("lower-case")).toBe("LOCAL_FAILURE");
    expect(safeCode(42)).toBe("LOCAL_FAILURE");
  });

  it("maps usage, operational, platform, and unknown failures to stable exit codes", () => {
    expect(classifyExitCode("USAGE_ERROR")).toBe(2);
    expect(classifyExitCode("RESULT_UNKNOWN")).toBe(4);
    expect(classifyExitCode("IPC_UNAVAILABLE")).toBe(3);
    expect(classifyExitCode("NODE_VERSION_UNSUPPORTED")).toBe(3);
    expect(classifyExitCode("SOMETHING_NEW")).toBe(5);

    const cliFailure = new CliFailure("USAGE_ERROR", 2);
    expect(codeFromError(cliFailure)).toBe("USAGE_ERROR");
    expect(codeFromError(new IpcTransportError("IPC_BUSY", "busy"))).toBe(
      "IPC_BUSY",
    );
    expect(codeFromError({ code: "SERVER_REJECTED" })).toBe("SERVER_REJECTED");
    expect(codeFromError({ code: "not safe" })).toBe("LOCAL_FAILURE");
    expect(codeFromError(new Error("no code"))).toBe("LOCAL_FAILURE");
  });

  it("enforces the Node 24 prerequisite and exposes a typed failure", () => {
    expect(() => ensureNodeVersion("24.0.0")).not.toThrow();
    expect(() => ensureNodeVersion("24")).not.toThrow();
    expect(() => ensureNodeVersion("23.9.0")).toThrowError(
      expect.objectContaining({
        code: "NODE_VERSION_UNSUPPORTED",
        exitCode: 3,
      }),
    );
    expect(() => ensureNodeVersion("not-a-version")).toThrowError(
      "NODE_VERSION_UNSUPPORTED",
    );
    expect(() => failure("not safe")).toThrowError(
      expect.objectContaining({ code: "LOCAL_FAILURE", exitCode: 5 }),
    );
  });

  it("normalizes daemon and raw results without trusting schema or command fields", () => {
    expect(
      normalizeFinal("send", {
        ok: true,
        schemaVersion: 9,
        command: "status",
        value: 1,
      }),
    ).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "status",
      value: 1,
    });
    expect(
      normalizeFinal("service install", {
        ok: false,
        command: "invalid",
        error: { code: "X" },
      }),
    ).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "service",
      error: { code: "X" },
    });
    expect(normalizeFinal("status", { state: "ready" })).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "status",
      result: { state: "ready" },
    });
  });

  it("provides localized messages and safely handles backpressure", async () => {
    expect(localizedMessage("NOT_LOGGED_IN", "zh-CN")).toContain("尚未登录");
    expect(localizedMessage("NOT_LOGGED_IN", "en")).toContain("not logged in");
    expect(localizedMessage("SESSION_EXPIRED", "zh-CN")).toContain(
      "blocked: 微信会话已过期，请先给 ClawBot 发一条消息",
    );
    expect(localizedMessage("UNKNOWN", "zh-CN")).toContain("UNKNOWN");
    expect(localizedMessage("UNKNOWN", "en")).toContain("UNKNOWN");

    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await writeOutput(output, "ready\n");
    expect(Buffer.concat(chunks).toString()).toBe("ready\n");

    const blocked = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(callback);
      },
      highWaterMark: 1,
    });
    const drained = writeOutput(blocked, "x".repeat(100));
    await new Promise<void>((resolve) => blocked.once("drain", resolve));
    await drained;

    const failing = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("closed"));
      },
    });
    await expect(writeOutput(failing, "x")).rejects.toThrow("closed");
  });
});
