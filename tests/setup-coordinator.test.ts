import { describe, expect, it, vi } from "vitest";

import {
  SetupCoordinator,
  type SetupInstallationStore,
} from "../src/setup/coordinator.js";
import type { InstallationState } from "../src/storage/installation-store.js";
import type { RelayCredential } from "../src/storage/relay-credential-store.js";

describe("one-command setup coordinator", () => {
  it("provisions a fresh personal Hub, starts it, binds Weixin, and returns an invitation", async () => {
    let installation: InstallationState | null = null;
    let credential: RelayCredential | null = null;
    const calls: string[] = [];
    const coordinator = new SetupCoordinator({
      installationStore: memoryInstallationStore(
        () => installation,
        (value) => {
          installation = value;
        },
      ),
      credentialStore: {
        load: async () => credential,
        save: async (value) => {
          credential = value;
        },
        delete: async () => {
          credential = null;
        },
      },
      prepare: async () => {
        calls.push("prepare");
      },
      provision: async ({ workerName, hubAuthToken }) => {
        calls.push(`provision:${workerName}:${hubAuthToken}`);
        return {
          accountId: "account-1",
          workerName,
          relayUrl: `https://${workerName}.alice.workers.dev`,
        };
      },
      deprovision: vi.fn(),
      service: {
        status: async () => ({ installed: false, running: false }),
        install: async () => {
          calls.push("install");
        },
        start: async () => {
          calls.push("start");
        },
      },
      ipc: (() => {
        let statusCalls = 0;
        return async (payload) => {
          calls.push(`ipc:${payload.command}`);
          if (payload.command === "status")
            return {
              ok: true,
              result: {
                state: (statusCalls += 1) === 1 ? "not_logged_in" : "ready",
              },
            };
          if (payload.command === "login")
            return { ok: true, state: "awaiting_message" };
          return {
            ok: true,
            result: { invitation: "sw1.hub-invitation" },
          };
        };
      })(),
      pairDevice: vi.fn(),
      randomBytes: (size) => Buffer.alloc(size, size),
      sleep: async () => undefined,
    });

    const onAwaitingMessage = vi.fn();
    await expect(coordinator.setup({ onAwaitingMessage })).resolves.toEqual({
      ok: true,
      command: "setup",
      result: {
        role: "hub",
        relayUrl: "https://send-wechat-04040404.alice.workers.dev",
        state: "ready",
        invitation: "sw1.hub-invitation",
      },
    });
    expect(installation).toEqual({
      schemaVersion: 1,
      role: "hub",
      relayUrl: "https://send-wechat-04040404.alice.workers.dev",
      workerName: "send-wechat-04040404",
      accountId: "account-1",
    });
    expect(credential).toEqual({
      schemaVersion: 1,
      role: "hub",
      hubAuthToken: Buffer.alloc(32, 32).toString("base64url"),
      devices: [],
    });
    expect(onAwaitingMessage).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "prepare",
      `provision:send-wechat-04040404:${Buffer.alloc(32, 32).toString("base64url")}`,
      "install",
      "start",
      "ipc:status",
      "ipc:login",
      "ipc:status",
      "ipc:pairing_invitation",
    ]);
  });

  it("adds a fresh remote client without installing a daemon or binding Weixin", async () => {
    let installation: InstallationState | null = null;
    let credential: RelayCredential | null = null;
    const install = vi.fn();
    const ipc = vi.fn();
    const pairDevice = vi.fn(async () => ({
      relayUrl: "https://alice.workers.dev",
      credential: {
        schemaVersion: 1 as const,
        role: "client" as const,
        deviceId: Buffer.alloc(16, 1).toString("base64url"),
        deviceKey: Buffer.alloc(32, 2).toString("base64url"),
      },
    }));
    const coordinator = new SetupCoordinator({
      installationStore: memoryInstallationStore(
        () => installation,
        (value) => {
          installation = value;
        },
      ),
      credentialStore: {
        load: async () => credential,
        save: async (value) => {
          credential = value;
        },
        delete: async () => {
          credential = null;
        },
      },
      prepare: async () => undefined,
      provision: vi.fn(),
      deprovision: vi.fn(),
      service: {
        status: async () => ({ installed: false, running: false }),
        install,
        start: vi.fn(),
      },
      ipc,
      pairDevice,
      randomBytes: (size) => Buffer.alloc(size),
      sleep: async () => undefined,
    });

    await expect(
      coordinator.setup({ pair: "sw1.invitation" }),
    ).resolves.toEqual({
      ok: true,
      command: "setup",
      result: {
        role: "client",
        relayUrl: "https://alice.workers.dev",
        state: "paired",
      },
    });
    expect(pairDevice).toHaveBeenCalledWith("sw1.invitation");
    expect(installation).toEqual({
      schemaVersion: 1,
      role: "client",
      relayUrl: "https://alice.workers.dev",
      deviceId: Buffer.alloc(16, 1).toString("base64url"),
    });
    expect(credential).toMatchObject({ role: "client" });
    expect(install).not.toHaveBeenCalled();
    expect(ipc).not.toHaveBeenCalled();
  });

  it("reuses an existing Hub to issue an invitation and rejects inconsistent state", async () => {
    const installation: InstallationState = {
      schemaVersion: 1,
      role: "hub",
      relayUrl: "https://alice.workers.dev",
      workerName: "send-wechat-existing",
      accountId: "account-1",
    };
    const credential: RelayCredential = {
      schemaVersion: 1,
      role: "hub",
      hubAuthToken: Buffer.alloc(32, 4).toString("base64url"),
      devices: [],
    };
    const ipc = vi.fn(async (payload: { command: string }) =>
      payload.command === "status"
        ? { ok: true, result: { state: "ready" } }
        : { ok: true, result: { invitation: "sw1.existing" } },
    );
    const dependencies = {
      installationStore: memoryInstallationStore(
        () => installation,
        () => undefined,
      ),
      credentialStore: {
        load: async () => credential,
        save: async () => undefined,
        delete: async () => undefined,
      },
      prepare: async () => undefined,
      provision: vi.fn(),
      deprovision: vi.fn(),
      service: {
        status: async () => ({ installed: true, running: true }),
        install: vi.fn(),
        start: vi.fn(),
      },
      ipc,
      pairDevice: vi.fn(),
      randomBytes: (size: number) => Buffer.alloc(size),
      sleep: async () => undefined,
    };
    await expect(new SetupCoordinator(dependencies).setup({})).resolves.toEqual(
      {
        ok: true,
        command: "setup",
        result: {
          role: "hub",
          relayUrl: "https://alice.workers.dev",
          state: "ready",
          invitation: "sw1.existing",
        },
      },
    );
    expect(ipc).toHaveBeenCalledTimes(2);

    await expect(
      new SetupCoordinator({
        ...dependencies,
        credentialStore: {
          ...dependencies.credentialStore,
          load: async () => null,
        },
      }).setup({}),
    ).rejects.toMatchObject({ code: "INSTALLATION_INCONSISTENT" });
  });

  it("keeps an existing client local and rejects replacing its immutable role", async () => {
    const installation: InstallationState = {
      schemaVersion: 1,
      role: "client",
      relayUrl: "https://alice.workers.dev",
      deviceId: Buffer.alloc(16, 6).toString("base64url"),
    };
    const credential: RelayCredential = {
      schemaVersion: 1,
      role: "client",
      deviceId: installation.deviceId,
      deviceKey: Buffer.alloc(32, 7).toString("base64url"),
    };
    const coordinator = new SetupCoordinator({
      installationStore: memoryInstallationStore(
        () => installation,
        () => undefined,
      ),
      credentialStore: {
        load: async () => credential,
        save: async () => undefined,
        delete: async () => undefined,
      },
      prepare: async () => undefined,
      provision: vi.fn(),
      deprovision: vi.fn(),
      service: {
        status: vi.fn(),
        install: vi.fn(),
        start: vi.fn(),
      },
      ipc: vi.fn(),
      pairDevice: vi.fn(),
      randomBytes: (size) => Buffer.alloc(size),
      sleep: async () => undefined,
    });
    await expect(coordinator.setup({})).resolves.toMatchObject({
      result: { role: "client", state: "paired" },
    });
    await expect(
      coordinator.setup({ pair: "sw1.replacement" }),
    ).rejects.toMatchObject({ code: "INSTALLATION_ALREADY_CONFIGURED" });
  });
});

function memoryInstallationStore(
  read: () => InstallationState | null,
  write: (value: InstallationState | null) => void,
): SetupInstallationStore {
  return {
    load: async () => read(),
    save: async (value) => {
      write(value);
    },
    delete: async () => {
      write(null);
    },
  };
}
