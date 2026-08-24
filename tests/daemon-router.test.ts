import { describe, expect, it, vi } from "vitest";

import { DaemonRequestRouter } from "../src/daemon/router.js";
import type { LoginInteraction } from "../src/runtime/login-coordinator.js";

describe("daemon request router", () => {
  it("maps an IPC file request into the runtime without losing integrity metadata", async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      command: "send",
      requestId: "r1",
    }));
    const router = new DaemonRequestRouter({
      runtime: { execute },
      login: { login: vi.fn() },
      withPollingPaused: async (operation) => operation(),
      doctor: async () => ({ credentialStore: "available" }),
      issuePairingInvitation: () => "sw1.invitation",
    });

    const result = await router.handle(
      {
        command: "send_file",
        requestId: "r1",
        idempotencyKey: "job-1",
        fileName: "report.txt",
        byteLength: 5,
        contentSha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        stagedPath: "/owner/tmp/staged",
      },
      { emit: vi.fn(), requestVerifyCode: vi.fn() },
    );

    expect(result).toEqual({ ok: true, command: "send", requestId: "r1" });
    expect(execute).toHaveBeenCalledWith({
      type: "send-file",
      requestId: "r1",
      idempotencyKey: "job-1",
      fileName: "report.txt",
      byteLength: 5,
      contentSha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      stagedPath: "/owner/tmp/staged",
    });
  });

  it("streams login QR and Tencent pairing states through IPC", async () => {
    const emit = vi.fn(async () => undefined);
    const requestVerifyCode = vi.fn(async () => "123456");
    const login = vi.fn(async (interaction: LoginInteraction) => {
      await interaction.onQr("https://weixin.qq.com/qr/example");
      await interaction.onState("scaned");
      expect(await interaction.requestVerifyCode()).toBe("123456");
      return {
        ok: true as const,
        state: "awaiting_message" as const,
        recovered: false,
      };
    });
    const router = new DaemonRequestRouter({
      runtime: { execute: vi.fn() },
      login: { login },
      withPollingPaused: async (operation) => operation(),
      doctor: async () => ({ credentialStore: "available" }),
      issuePairingInvitation: () => "sw1.invitation",
    });

    await expect(
      router.handle(
        { command: "login", requestId: "r2" },
        { emit, requestVerifyCode },
      ),
    ).resolves.toEqual({
      ok: true,
      state: "awaiting_message",
      recovered: false,
    });
    expect(emit).toHaveBeenNthCalledWith(1, {
      type: "qr",
      content: "https://weixin.qq.com/qr/example",
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      type: "login_state",
      state: "scaned",
    });
  });

  it("does not expose reset through a running daemon", async () => {
    const router = new DaemonRequestRouter({
      runtime: { execute: vi.fn() },
      login: { login: vi.fn() },
      withPollingPaused: async (operation) => operation(),
      doctor: async () => ({ credentialStore: "available" }),
      issuePairingInvitation: () => "sw1.invitation",
    });
    await expect(
      router.handle(
        { command: "reset", requestId: "r3" },
        { emit: vi.fn(), requestVerifyCode: vi.fn() },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "RESET_REQUIRES_STOPPED_DAEMON", retryable: false },
    });
  });

  it("issues pairing invitations only through the running Hub", async () => {
    const issuePairingInvitation = vi.fn(() => "sw1.invitation");
    const router = new DaemonRequestRouter({
      runtime: { execute: vi.fn() },
      login: { login: vi.fn() },
      withPollingPaused: async (operation) => operation(),
      doctor: async () => ({ credentialStore: "available" }),
      issuePairingInvitation,
    });
    await expect(
      router.handle(
        { command: "pairing_invitation", requestId: "pair-1" },
        { emit: vi.fn(), requestVerifyCode: vi.fn() },
      ),
    ).resolves.toEqual({
      ok: true,
      command: "setup",
      requestId: "pair-1",
      result: { invitation: "sw1.invitation" },
    });
    expect(issuePairingInvitation).toHaveBeenCalledOnce();
  });

  it("holds new sends behind an in-progress login", async () => {
    let finishLogin: (() => void) | undefined;
    const loginGate = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    const execute = vi.fn(async () => ({ ok: false }));
    const router = new DaemonRequestRouter({
      runtime: { execute },
      login: {
        async login() {
          await loginGate;
          return { ok: true, state: "awaiting_message", recovered: false };
        },
      },
      withPollingPaused: async (operation) => operation(),
      doctor: async () => ({ credentialStore: "available" }),
      issuePairingInvitation: () => "sw1.invitation",
    });
    const context = { emit: vi.fn(), requestVerifyCode: vi.fn() };

    const login = router.handle(
      { command: "login", requestId: "login" },
      context,
    );
    const send = router.handle(
      {
        command: "send_text",
        requestId: "send",
        idempotencyKey: "after-login",
        text: "hello",
      },
      context,
    );
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    finishLogin?.();
    await login;
    await send;
    expect(execute).toHaveBeenCalledOnce();
  });
});
