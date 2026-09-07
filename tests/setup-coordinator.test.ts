import { describe, expect, it, vi } from "vitest";

import {
  type PersistSetupClientPair,
  type SetupClientPair,
  SetupCoordinator,
  type SetupCredentialStore,
  type SetupInstallationStore,
} from "../src/setup/coordinator.js";
import type { InstallationState } from "../src/storage/installation-store.js";
import type { RelayCredential } from "../src/storage/relay-credential-store.js";

describe("one-command setup coordinator", () => {
  it("provisions a fresh personal Hub, starts it, and binds Weixin without issuing an invitation", async () => {
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
    ]);
  });

  it("adds a fresh remote client without installing a daemon or binding Weixin", async () => {
    let installation: InstallationState | null = null;
    let credential: RelayCredential | null = null;
    const install = vi.fn();
    const prepare = vi.fn();
    const ipc = vi.fn();
    const pairDevice = vi.fn(async (_invitation, persist) => {
      const paired = {
        relayUrl: "https://alice.workers.dev",
        credential: {
          schemaVersion: 1 as const,
          role: "client" as const,
          deviceId: Buffer.alloc(16, 1).toString("base64url"),
          deviceKey: Buffer.alloc(32, 2).toString("base64url"),
        },
      };
      await persist(paired);
      return paired;
    });
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
      prepare,
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
    expect(pairDevice).toHaveBeenCalledWith(
      "sw1.invitation",
      expect.any(Function),
    );
    expect(prepare).not.toHaveBeenCalled();
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

  it("persists before the adapter can consume an invitation", async () => {
    let invitationConsumed = false;
    const fixture = clientFixture({
      saveCredential: async () => {
        throw new Error("credential store unavailable");
      },
      pairDevice: async (_invitation, persist) => {
        await persist(remotePair);
        invitationConsumed = true;
        return remotePair;
      },
    });

    await expect(
      fixture.coordinator.setup({ pair: "sw1.invitation" }),
    ).rejects.toMatchObject({ code: "SETUP_CLIENT_STORAGE_FAILED" });
    expect(invitationConsumed).toBe(false);
    expect(fixture.credential()).toBeNull();
    expect(fixture.installation()).toBeNull();
    expect(fixture.credentialDelete).toHaveBeenCalledOnce();
    expect(fixture.installationDelete).toHaveBeenCalledOnce();
  });

  it("rolls back both records when credential readback differs", async () => {
    const fixture = clientFixture({
      readCredential: (saved) =>
        saved === null
          ? null
          : {
              ...saved,
              deviceKey: Buffer.alloc(32, 9).toString("base64url"),
            },
    });

    await expect(
      fixture.coordinator.setup({ pair: "sw1.invitation" }),
    ).rejects.toMatchObject({ code: "SETUP_CLIENT_READBACK_MISMATCH" });
    expect(fixture.credential()).toBeNull();
    expect(fixture.installation()).toBeNull();
  });

  it("rolls back both records when installation saving fails", async () => {
    const fixture = clientFixture({
      saveInstallation: async () => {
        throw new Error("installation store unavailable");
      },
    });

    await expect(
      fixture.coordinator.setup({ pair: "sw1.invitation" }),
    ).rejects.toMatchObject({ code: "SETUP_CLIENT_STORAGE_FAILED" });
    expect(fixture.credential()).toBeNull();
    expect(fixture.installation()).toBeNull();
  });

  it("rolls back both records when the exchange fails after persistence", async () => {
    const fixture = clientFixture({
      pairDevice: async (_invitation, persist) => {
        await persist(remotePair);
        throw new Error("exchange failed");
      },
    });

    await expect(
      fixture.coordinator.setup({ pair: "sw1.invitation" }),
    ).rejects.toThrow("exchange failed");
    expect(fixture.credential()).toBeNull();
    expect(fixture.installation()).toBeNull();
  });

  it("rejects an adapter result that differs from the persisted pair", async () => {
    const fixture = clientFixture({
      pairDevice: async (_invitation, persist) => {
        await persist(remotePair);
        return { ...remotePair, relayUrl: "https://other.workers.dev" };
      },
    });

    await expect(
      fixture.coordinator.setup({ pair: "sw1.invitation" }),
    ).rejects.toMatchObject({ code: "SETUP_CLIENT_PAIR_MISMATCH" });
    expect(fixture.credential()).toBeNull();
    expect(fixture.installation()).toBeNull();
  });

  it("finishes all persistence and readback before the adapter returns", async () => {
    const events: string[] = [];
    const fixture = clientFixture({ events });
    events.length = 0;

    await expect(
      fixture.coordinator.setup({ pair: "sw1.invitation" }),
    ).resolves.toMatchObject({ result: { state: "paired" } });
    expect(events.slice(-6)).toEqual([
      "credential.save",
      "installation.save",
      "credential.load",
      "installation.load",
      "exchange",
      "pair.return",
    ]);
  });

  it("surfaces cleanup failure instead of swallowing it", async () => {
    const fixture = clientFixture({
      pairDevice: async (_invitation, persist) => {
        await persist(remotePair);
        throw new Error("exchange failed");
      },
      deleteCredential: async () => {
        throw new Error("credential cleanup failed");
      },
    });

    await expect(
      fixture.coordinator.setup({ pair: "sw1.invitation" }),
    ).rejects.toMatchObject({ code: "SETUP_CLIENT_CLEANUP_FAILED" });
  });

  it("reuses an existing Hub and issues an invitation only when requested", async () => {
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
        },
      },
    );
    expect(ipc).toHaveBeenCalledTimes(1);

    ipc.mockClear();
    await expect(
      new SetupCoordinator(dependencies).setup({ issueInvitation: true }),
    ).resolves.toEqual({
      ok: true,
      command: "setup",
      result: {
        role: "hub",
        relayUrl: "https://alice.workers.dev",
        state: "ready",
        invitation: "sw1.existing",
      },
    });
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
    const deleteCredential = vi.fn();
    const deleteInstallation = vi.fn();
    const coordinator = new SetupCoordinator({
      installationStore: {
        load: async () => installation,
        save: async () => undefined,
        delete: deleteInstallation,
      },
      credentialStore: {
        load: async () => credential,
        save: async () => undefined,
        delete: deleteCredential,
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
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(deleteInstallation).not.toHaveBeenCalled();
  });
});

const remotePair: SetupClientPair = {
  relayUrl: "https://alice.workers.dev",
  credential: {
    schemaVersion: 1,
    role: "client",
    deviceId: Buffer.alloc(16, 1).toString("base64url"),
    deviceKey: Buffer.alloc(32, 2).toString("base64url"),
  },
};

type ClientFixtureOptions = {
  readonly events?: string[];
  readonly pairDevice?: (
    invitation: string,
    persist: PersistSetupClientPair,
  ) => Promise<SetupClientPair>;
  readonly saveCredential?: (value: RelayCredential) => Promise<void>;
  readonly saveInstallation?: (value: InstallationState) => Promise<void>;
  readonly readCredential?: (
    saved: RelayCredential | null,
  ) => RelayCredential | null;
  readonly readInstallation?: (
    saved: InstallationState | null,
  ) => InstallationState | null;
  readonly deleteCredential?: () => Promise<void>;
  readonly deleteInstallation?: () => Promise<void>;
};

function clientFixture(options: ClientFixtureOptions = {}): {
  coordinator: SetupCoordinator;
  credential: () => RelayCredential | null;
  installation: () => InstallationState | null;
  credentialDelete: ReturnType<typeof vi.fn>;
  installationDelete: ReturnType<typeof vi.fn>;
} {
  let installation: InstallationState | null = null;
  let credential: RelayCredential | null = null;
  const events = options.events ?? [];
  const credentialDelete = vi.fn(async () => {
    events.push("credential.delete");
    if (options.deleteCredential !== undefined) {
      await options.deleteCredential();
      return;
    }
    credential = null;
  });
  const installationDelete = vi.fn(async () => {
    events.push("installation.delete");
    if (options.deleteInstallation !== undefined) {
      await options.deleteInstallation();
      return;
    }
    installation = null;
  });
  const credentialStore: SetupCredentialStore = {
    load: async () => {
      events.push("credential.load");
      return options.readCredential?.(credential) ?? credential;
    },
    save: async (value) => {
      events.push("credential.save");
      if (options.saveCredential !== undefined) {
        await options.saveCredential(value);
        return;
      }
      credential = value;
    },
    delete: credentialDelete,
  };
  const installationStore: SetupInstallationStore = {
    load: async () => {
      events.push("installation.load");
      return options.readInstallation?.(installation) ?? installation;
    },
    save: async (value) => {
      events.push("installation.save");
      if (options.saveInstallation !== undefined) {
        await options.saveInstallation(value);
        return;
      }
      installation = value;
    },
    delete: installationDelete,
  };
  const pairDevice =
    options.pairDevice ??
    (async (_invitation: string, persist: PersistSetupClientPair) => {
      await persist(remotePair);
      events.push("exchange");
      events.push("pair.return");
      return remotePair;
    });
  const coordinator = new SetupCoordinator({
    installationStore,
    credentialStore,
    prepare: vi.fn(),
    provision: vi.fn(),
    deprovision: vi.fn(),
    service: {
      status: vi.fn(),
      install: vi.fn(),
      start: vi.fn(),
    },
    ipc: vi.fn(),
    pairDevice,
    randomBytes: (size) => Buffer.alloc(size),
    sleep: async () => undefined,
  });
  return {
    coordinator,
    credential: () => credential,
    installation: () => installation,
    credentialDelete,
    installationDelete,
  };
}

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
