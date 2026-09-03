import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PairingInvitations } from "../src/relay/invitation.js";
import { humanSuccess, runCommand } from "../src/cli/operations.js";
import type { CliContext } from "../src/cli/context.js";
import type { InstallationState } from "../src/storage/installation-store.js";

type FakeContext = {
  ipc: (...args: unknown[]) => Promise<unknown>;
  dispatch: (...args: unknown[]) => Promise<unknown>;
  setup: (options: { qrFile?: string }) => Promise<unknown>;
  randomUUID: () => string;
  readStdin: () => Promise<string>;
  nodeVersion: () => string;
  getPlatform: () => string;
  getServiceManager: () => {
    status: () => Promise<{ installed: boolean; running: boolean }>;
    stop: () => Promise<void>;
  };
  capability: () => Promise<string>;
  confirmReset: () => Promise<string | null>;
  reset: () => Promise<void>;
  deprovisionRelay: () => Promise<void>;
  installation: () => Promise<InstallationState | null>;
  renderQr: (...args: unknown[]) => Promise<void>;
  emitLoginState: (state: string) => Promise<void>;
  verifyCode: () => Promise<string | null>;
};

function context(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    ipc: async () => ({
      ok: true,
      command: "status",
      result: { state: "ready" },
    }),
    dispatch: async () => ({
      ok: true,
      command: "status",
      result: { state: "ready" },
    }),
    setup: async () => ({
      ok: true,
      command: "setup",
      result: { role: "client", state: "paired" },
    }),
    randomUUID: () => "generated-key",
    readStdin: async () => "stdin text",
    nodeVersion: () => "24.0.0",
    getPlatform: () => "darwin",
    getServiceManager: () => ({
      status: async () => ({ installed: true, running: false }),
      stop: async () => {},
    }),
    capability: async () => "a".repeat(64),
    confirmReset: async () => "RESET",
    reset: async () => {},
    deprovisionRelay: async () => {},
    installation: async () => null,
    renderQr: async () => {},
    emitLoginState: async () => {},
    verifyCode: async () => null,
    ...overrides,
  };
}

describe("CLI operations", () => {
  it("routes status, setup, stdin text, and files to the installation-aware contract", async () => {
    const calls: unknown[][] = [];
    const events: string[] = [];
    const fake = context({
      dispatch: async (...args) => {
        calls.push(args);
        const payload = args[0] as { command: string };
        return payload.command === "status"
          ? { ok: true, command: "status", result: { state: "ready" } }
          : payload.command === "send_text"
            ? { ok: true, command: "send", result: { state: "accepted" } }
            : { ok: true, command: "send", state: "accepted" };
      },
      setup: async () => {
        events.push("qr:qr", "state:wait", "verify");
        return { ok: true, command: "setup", state: "awaiting_message" };
      },
      renderQr: async (content) => {
        events.push(`qr:${String(content)}`);
      },
      emitLoginState: async (state) => {
        events.push(`state:${state}`);
      },
      verifyCode: async () => {
        events.push("verify");
        return "1234";
      },
    });
    await expect(
      runCommand(fake as unknown as CliContext, "status", {}),
    ).resolves.toMatchObject({
      ok: true,
      command: "status",
    });
    await expect(
      runCommand(fake as unknown as CliContext, "setup", {}),
    ).resolves.toMatchObject({
      ok: true,
      command: "setup",
    });
    await expect(
      runCommand(fake as unknown as CliContext, "send", { text: "hello" }),
    ).resolves.toMatchObject({
      ok: true,
      command: "send",
    });
    expect(events).toEqual(["qr:qr", "state:wait", "verify"]);
    expect(calls[1]?.[0]).toMatchObject({ command: "send_text" });
  });

  it("reads and trims a pairing invitation from stdin", async () => {
    const calls: unknown[] = [];
    const invitation = new PairingInvitations().issue(
      "https://alice.workers.dev",
    );
    const fake = context({
      readStdin: async () => `\n  ${invitation}  \n`,
      setup: async (options) => {
        calls.push(options);
        return { ok: true, command: "setup", state: "paired" };
      },
    });
    await expect(
      runCommand(fake as unknown as CliContext, "setup", {
        pairStdin: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: "setup",
    });
    expect(calls).toEqual([{ pair: invitation }]);
  });

  it("rejects pairing invitation argv and stdin together", async () => {
    const setup = vi.fn(async () => ({
      ok: true,
      command: "setup",
      state: "paired",
    }));
    const fake = context({ setup });
    const invitation = new PairingInvitations().issue(
      "https://alice.workers.dev",
    );
    await expect(
      runCommand(fake as unknown as CliContext, "setup", {
        pair: invitation,
        pairStdin: true,
      }),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
    expect(setup).not.toHaveBeenCalled();
  });

  it("validates send input, file safety, and idempotency keys before IPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-operations-"));
    try {
      const calls: unknown[] = [];
      const fake = context({
        dispatch: async (...args) => {
          calls.push(args);
          return { ok: true, command: "send", result: { state: "accepted" } };
        },
      });
      await expect(
        runCommand(fake as unknown as CliContext, "send", {}),
      ).rejects.toMatchObject({ code: "USAGE_ERROR" });
      await expect(
        runCommand(fake as unknown as CliContext, "send", {
          text: "",
          stdin: true,
        }),
      ).rejects.toMatchObject({ code: "USAGE_ERROR" });
      await expect(
        runCommand(fake as unknown as CliContext, "send", {
          text: "hello",
          idempotencyKey: "bad key",
        }),
      ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
      await expect(
        runCommand(fake as unknown as CliContext, "send", {
          text: "😀".repeat(4001),
        }),
      ).rejects.toMatchObject({ code: "INVALID_TEXT" });
      await expect(
        runCommand(fake as unknown as CliContext, "send", {
          file: join(root, "missing.txt"),
        }),
      ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
      const directory = join(root, "directory");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
      await expect(
        runCommand(fake as unknown as CliContext, "send", { file: directory }),
      ).rejects.toMatchObject({ code: "FILE_UNSAFE" });
      const target = join(root, "target.txt");
      const link = join(root, "link.txt");
      await writeFile(target, "target");
      await symlink(target, link);
      await expect(
        runCommand(fake as unknown as CliContext, "send", { file: link }),
      ).rejects.toMatchObject({ code: "FILE_UNSAFE" });
      expect(calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports doctor checks and reset lifecycle in a safe aggregate result", async () => {
    const calls: string[] = [];
    const fake = context({
      getPlatform: () => {
        throw Object.assign(new Error("unsupported"), {
          code: "UNSUPPORTED_PLATFORM",
        });
      },
      getServiceManager: () => ({
        status: async () => {
          throw Object.assign(new Error("not ready"), {
            code: "SERVICE_NOT_READY",
          });
        },
        stop: async () => {
          calls.push("stop");
        },
      }),
      capability: async () => {
        throw Object.assign(new Error("missing"), {
          code: "CAPABILITY_NOT_INITIALIZED",
        });
      },
      confirmReset: async () => "RESET",
      reset: async () => {
        calls.push("reset");
      },
      ipc: async () => ({
        ok: false,
        error: { code: "DAEMON_FAILURE" },
      }),
    });
    await expect(
      runCommand(fake as unknown as CliContext, "doctor", {}),
    ).resolves.toMatchObject({
      ok: false,
      checks: {
        platform: { ok: false, code: "UNSUPPORTED_PLATFORM" },
        service: { ok: false, code: "SERVICE_NOT_READY" },
        capability: { ok: false, code: "CAPABILITY_NOT_INITIALIZED" },
        daemon: { ok: false, code: "CAPABILITY_NOT_INITIALIZED" },
      },
    });
    const resetContext = context({
      deprovisionRelay: async () => {
        calls.push("deprovision");
      },
      getServiceManager: () => ({
        status: async () => ({ installed: true, running: true }),
        stop: async () => {
          calls.push("stop");
        },
      }),
      reset: async () => {
        calls.push("reset");
      },
    });
    await expect(
      runCommand(resetContext as unknown as CliContext, "reset", {}),
    ).resolves.toMatchObject({
      ok: true,
      command: "reset",
    });
    expect(calls).toEqual(["deprovision", "stop", "reset"]);
    await expect(
      runCommand(fake as unknown as CliContext, "unknown", {}),
    ).rejects.toMatchObject({ code: "USAGE_ERROR" });
  });

  it("checks the personal relay instead of a local service on remote clients", async () => {
    const service = vi.fn();
    const fake = context({
      installation: async () => ({
        schemaVersion: 1,
        role: "client",
        relayUrl: "https://alice.workers.dev",
        deviceId: Buffer.alloc(16, 1).toString("base64url"),
      }),
      dispatch: async () => ({
        ok: true,
        command: "status",
        result: { state: "ready" },
      }),
      getServiceManager: service as never,
    });
    await expect(
      runCommand(fake as unknown as CliContext, "doctor", {}),
    ).resolves.toMatchObject({
      ok: true,
      checks: {
        installation: { ok: true, value: "client" },
        relay: { ok: true },
      },
    });
    expect(service).not.toHaveBeenCalled();
  });

  it("renders human success for every public command and safe deduplication", () => {
    expect(
      humanSuccess("send", { result: { deduplicated: true } }, "zh-CN"),
    ).toContain("去重");
    expect(
      humanSuccess("send", { result: { deduplicated: true } }, "en"),
    ).toContain("deduplicated");
    expect(humanSuccess("reset", {}, "en")).toContain("Reset");
    expect(
      humanSuccess("setup", { result: { role: "client" } }, "zh-CN"),
    ).toContain("Relay");
    expect(humanSuccess("service install", {}, "en")).toContain("Service");
    expect(
      humanSuccess("status", { result: { state: "ready" } }, "en"),
    ).toContain("ready");
    expect(
      humanSuccess(
        "doctor",
        { checks: { node: { ok: true }, extra: { ok: false } } },
        "zh-CN",
      ),
    ).toContain("failed");
    expect(humanSuccess("other", {}, "en")).toBe("Done.\n");
  });
});
