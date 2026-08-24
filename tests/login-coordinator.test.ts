import { describe, expect, it } from "vitest";

import { LoginCoordinator } from "../src/runtime/login-coordinator.js";
import type { QrStatus } from "../src/ilink/client.js";
import type { CredentialStore, StateStore } from "../src/runtime/ports.js";
import type { PersistedState, SecretBundle } from "../src/runtime/state.js";

class MemoryStateStore implements StateStore {
  public constructor(public state: PersistedState | null = null) {}
  async load(): Promise<PersistedState | null> {
    return structuredClone(this.state);
  }
  async save(state: PersistedState): Promise<void> {
    this.state = structuredClone(state);
  }
  async delete(): Promise<void> {
    this.state = null;
  }
}

class MemoryCredentialStore implements CredentialStore {
  public constructor(public secret: SecretBundle | null = null) {}
  async load(): Promise<SecretBundle | null> {
    return structuredClone(this.secret);
  }
  async save(secret: SecretBundle): Promise<void> {
    this.secret = structuredClone(secret);
  }
  async delete(): Promise<void> {
    this.secret = null;
  }
  async available(): Promise<boolean> {
    return true;
  }
}

describe("login coordinator interface", () => {
  it("classifies QR creation, cancellation, protocol, verification, and redirect failures", async () => {
    const base = {
      onQr: async () => {},
      onState: async () => {},
      requestVerifyCode: async () => null,
    };
    const createFailure = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          throw new Error("network");
        },
        async pollQr() {
          return { status: "wait" };
        },
      },
      clock: { now: () => 0 },
      sleep: async () => {},
    });
    await expect(createFailure.login(base)).resolves.toEqual({
      ok: false,
      error: { code: "QR_CREATE_FAILED", retryable: true },
    });

    const cancelled = new AbortController();
    cancelled.abort();
    const cancelCoordinator = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          return { qrcode: "q", qrContent: "c" };
        },
        async pollQr() {
          return { status: "wait" };
        },
      },
      clock: { now: () => 0 },
      sleep: async () => {},
    });
    await expect(
      cancelCoordinator.login({ ...base, signal: cancelled.signal }),
    ).resolves.toMatchObject({ error: { code: "LOGIN_CANCELLED" } });

    const protocolFailure = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          return { qrcode: "q", qrContent: "c" };
        },
        async pollQr() {
          throw new Error("bad protocol");
        },
      },
      clock: { now: () => 0 },
      sleep: async () => {},
    });
    await expect(protocolFailure.login(base)).resolves.toMatchObject({
      error: { code: "QR_PROTOCOL_FAILED" },
    });

    const invalidVerify = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          return { qrcode: "q", qrContent: "c" };
        },
        async pollQr() {
          return { status: "need_verifycode" };
        },
      },
      clock: { now: () => 0 },
      sleep: async () => {},
    });
    await expect(
      invalidVerify.login({ ...base, requestVerifyCode: async () => "abc" }),
    ).resolves.toMatchObject({ error: { code: "VERIFY_CODE_REQUIRED" } });

    const redirect = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          return { qrcode: "q", qrContent: "c" };
        },
        async pollQr() {
          return {
            status: "scaned_but_redirect",
            redirectHost: "https://evil",
          };
        },
      },
      clock: { now: () => 0 },
      sleep: async () => {},
    });
    await expect(redirect.login(base)).resolves.toMatchObject({
      error: { code: "QR_REDIRECT_INVALID" },
    });
  });

  it("refreshes expired QR codes, rejects repeated expiry, and rejects missing recovery", async () => {
    let created = 0;
    const expired = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          created += 1;
          return { qrcode: `q${created}`, qrContent: `c${created}` };
        },
        async pollQr() {
          return { status: "expired" };
        },
      },
      clock: { now: () => 0 },
      sleep: async () => {},
    });
    await expect(
      expired.login({
        onQr: async () => {},
        onState: async () => {},
        requestVerifyCode: async () => null,
      }),
    ).resolves.toMatchObject({ error: { code: "QR_EXPIRED" } });
    expect(created).toBe(3);

    const recovery = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          return { qrcode: "q", qrContent: "c" };
        },
        async pollQr() {
          return { status: "binded_redirect" };
        },
      },
      clock: { now: () => 0 },
      sleep: async () => {},
    });
    await expect(
      recovery.login({
        onQr: async () => {},
        onState: async () => {},
        requestVerifyCode: async () => null,
      }),
    ).resolves.toMatchObject({
      error: { code: "EXISTING_BINDING_UNAVAILABLE" },
    });
  });

  it("binds the scanned user and waits for the first arbitrary inbound message", async () => {
    const stateStore = new MemoryStateStore();
    const credentialStore = new MemoryCredentialStore();
    const events: string[] = [];
    const statuses: QrStatus[] = [
      { status: "scaned" },
      {
        status: "confirmed",
        botToken: "bot-token",
        botId: "bot-id",
        userId: "user-id",
        baseUrl: "https://ilinkai.weixin.qq.com",
      },
    ];
    const coordinator = new LoginCoordinator({
      stateStore,
      credentialStore,
      ilink: {
        async createQr(tokens) {
          expect(tokens).toEqual([]);
          return { qrcode: "qr-token", qrContent: "https://qr.example/value" };
        },
        async pollQr() {
          return statuses.shift()!;
        },
      },
      clock: { now: () => Date.parse("2026-08-24T12:00:00.000Z") },
      sleep: async () => {},
    });

    const result = await coordinator.login({
      onQr: async (content) => {
        events.push(`qr:${content}`);
      },
      onState: async (state) => {
        events.push(`state:${state}`);
      },
      requestVerifyCode: async () => null,
    });

    expect(result).toEqual({
      ok: true,
      state: "awaiting_message",
      recovered: false,
    });
    expect(events).toEqual([
      "qr:https://qr.example/value",
      "state:scaned",
      "state:confirmed",
    ]);
    expect(stateStore.state).toMatchObject({
      schemaVersion: 1,
      binding: { botId: "bot-id", userId: "user-id" },
      pollCursor: "",
      lastInboundAt: null,
      authStale: false,
    });
    expect(credentialStore.secret).toEqual({
      schemaVersion: 1,
      botToken: "bot-token",
      contextToken: null,
    });
  });

  it("handles a Tencent-requested pairing code without adding a custom challenge", async () => {
    const verifyCodes: Array<string | undefined> = [];
    const statuses: QrStatus[] = [
      { status: "need_verifycode" },
      {
        status: "confirmed",
        botToken: "bot-token",
        botId: "bot-id",
        userId: "user-id",
        baseUrl: "https://ilinkai.weixin.qq.com",
      },
    ];
    const coordinator = new LoginCoordinator({
      stateStore: new MemoryStateStore(),
      credentialStore: new MemoryCredentialStore(),
      ilink: {
        async createQr() {
          return { qrcode: "qr-token", qrContent: "qr-content" };
        },
        async pollQr(params) {
          verifyCodes.push(params.verifyCode);
          return statuses.shift()!;
        },
      },
      clock: { now: () => Date.parse("2026-08-24T12:00:00.000Z") },
      sleep: async () => {},
    });

    const result = await coordinator.login({
      onQr: async () => {},
      onState: async () => {},
      requestVerifyCode: async () => "123456",
    });

    expect(result.ok).toBe(true);
    expect(verifyCodes).toEqual([undefined, "123456"]);
  });

  it("refuses recovery when the scanned user differs from the immutable binding", async () => {
    const existingState: PersistedState = {
      schemaVersion: 1,
      binding: {
        botId: "old-bot",
        userId: "original-user",
        baseUrl: "https://ilinkai.weixin.qq.com",
        boundAt: "2026-08-20T00:00:00.000Z",
      },
      pollCursor: "old-cursor",
      lastInboundAt: 1787000000000,
      reminderAttemptedFor: null,
      authStale: true,
    };
    const stateStore = new MemoryStateStore(existingState);
    const credentialStore = new MemoryCredentialStore({
      schemaVersion: 1,
      botToken: "old-token",
      contextToken: "old-context",
    });
    const coordinator = new LoginCoordinator({
      stateStore,
      credentialStore,
      ilink: {
        async createQr(tokens) {
          expect(tokens).toEqual(["old-token"]);
          return { qrcode: "qr-token", qrContent: "qr-content" };
        },
        async pollQr() {
          return {
            status: "confirmed",
            botToken: "different-token",
            botId: "different-bot",
            userId: "different-user",
            baseUrl: "https://ilinkai.weixin.qq.com",
          };
        },
      },
      clock: { now: () => Date.parse("2026-08-24T12:00:00.000Z") },
      sleep: async () => {},
    });

    const result = await coordinator.login({
      onQr: async () => {},
      onState: async () => {},
      requestVerifyCode: async () => null,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "BINDING_MISMATCH", retryable: false },
    });
    expect(stateStore.state).toEqual(existingState);
    expect(credentialStore.secret?.botToken).toBe("old-token");
  });
});
