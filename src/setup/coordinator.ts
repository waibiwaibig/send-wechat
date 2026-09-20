import { isDeepStrictEqual } from "node:util";

import type { IpcClientPayload, IpcEvent } from "../ipc/transport.js";
import type { InstallationState } from "../storage/installation-store.js";
import type {
  ClientRelayCredential,
  RelayCredential,
} from "../storage/relay-credential-store.js";

export type SetupInstallationStore = {
  load(): Promise<InstallationState | null>;
  save(value: InstallationState): Promise<void>;
  delete(): Promise<void>;
};

export type SetupCredentialStore = {
  load(): Promise<RelayCredential | null>;
  save(value: RelayCredential): Promise<void>;
  delete(): Promise<void>;
};

export type SetupResult = {
  ok: true;
  command: "setup";
  result:
    | {
        role: "local";
        state: string;
      }
    | {
        role: "hub";
        relayUrl: string;
        state: string;
        invitation?: string;
      }
    | {
        role: "client";
        relayUrl: string;
        state: "paired";
      };
};

export type SetupClientPair = {
  relayUrl: string;
  credential: ClientRelayCredential;
};

export type PersistSetupClientPair = (paired: SetupClientPair) => Promise<void>;

export class SetupCoordinatorError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "SetupCoordinatorError";
  }
}

export class SetupCoordinator {
  public constructor(
    private readonly dependencies: {
      readonly installationStore: SetupInstallationStore;
      readonly credentialStore: SetupCredentialStore;
      readonly prepare: () => Promise<void>;
      readonly provision: (input: {
        workerName: string;
        hubAuthToken: string;
      }) => Promise<{
        accountId: string;
        workerName: string;
        relayUrl: string;
      }>;
      readonly deprovision: (input: {
        workerName: string;
        accountId: string;
      }) => Promise<void>;
      readonly service: {
        status(): Promise<{ installed: boolean; running: boolean }>;
        install(): Promise<void>;
        start(): Promise<void>;
        restart?: () => Promise<void>;
      };
      readonly ipc: (
        payload: IpcClientPayload,
        onEvent?: (event: IpcEvent) => Promise<void> | void,
        onVerifyCode?: () => Promise<string | null>,
      ) => Promise<unknown>;
      readonly pairDevice: (
        invitation: string,
        persist: PersistSetupClientPair,
      ) => Promise<SetupClientPair>;
      readonly randomBytes: (size: number) => Buffer;
      readonly sleep: (milliseconds: number) => Promise<void>;
    },
  ) {}

  public async setup(options: {
    pair?: string;
    relay?: boolean;
    issueInvitation?: boolean;
    loginWechat?: boolean;
    onEvent?: (event: IpcEvent) => Promise<void> | void;
    onVerifyCode?: () => Promise<string | null>;
    onAwaitingMessage?: () => Promise<void> | void;
  }): Promise<SetupResult> {
    const installation = await this.dependencies.installationStore.load();

    if (options.pair !== undefined) {
      if (installation !== null)
        throw new SetupCoordinatorError("INSTALLATION_ALREADY_CONFIGURED");
      return await this.setupClient(options.pair);
    }

    const relayRequested =
      options.relay === true || options.issueInvitation === true;
    const needsCredential =
      installation?.role === "hub" ||
      installation?.role === "client" ||
      (installation?.role === "local" && relayRequested) ||
      (installation === null && relayRequested);
    const credential = needsCredential
      ? await this.dependencies.credentialStore.load()
      : null;
    if (installation?.role === "client" || credential?.role === "client") {
      if (installation?.role !== "client" || credential?.role !== "client")
        throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");
      return {
        ok: true,
        command: "setup",
        result: {
          role: "client",
          relayUrl: installation.relayUrl,
          state: "paired",
        },
      };
    }
    if (
      (installation?.role === "local" || installation === null) &&
      credential !== null
    )
      throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");
    if (installation?.role === "hub" && credential?.role !== "hub")
      throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");

    await this.dependencies.prepare();

    if (!relayRequested) {
      if (installation === null) {
        await this.dependencies.installationStore.save({
          schemaVersion: 1,
          role: "local",
        });
      } else if (installation.role !== "local" && installation.role !== "hub") {
        throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");
      }
      await this.ensureHubService();
      const state = await this.completeWechatSetup(options);
      if (installation?.role === "hub") {
        return {
          ok: true,
          command: "setup",
          result: {
            role: "hub",
            relayUrl: installation.relayUrl,
            state,
          },
        };
      }
      return {
        ok: true,
        command: "setup",
        result: { role: "local", state },
      };
    }

    const upgradingLocal = installation?.role === "local";
    let restartRunningService = false;
    if (upgradingLocal) {
      const status = await this.dependencies.service.status();
      restartRunningService = status.running;
      if (status.running && this.dependencies.service.restart === undefined)
        throw new SetupCoordinatorError("SETUP_SERVICE_RESTART_REQUIRED");
    }

    let hubInstallation = installation?.role === "hub" ? installation : null;
    let hubCredential = credential?.role === "hub" ? credential : null;
    const freshHub = hubInstallation === null && hubCredential === null;
    if (freshHub && installation !== null && !upgradingLocal)
      throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");
    if (freshHub) {
      const suffix = this.dependencies.randomBytes(4);
      const hubAuthToken = this.dependencies.randomBytes(32);
      if (suffix.byteLength !== 4 || hubAuthToken.byteLength !== 32)
        throw new SetupCoordinatorError("SETUP_RANDOM_INVALID");
      const workerName = `send-message-${suffix.toString("hex")}`;
      const provisioned = await this.dependencies.provision({
        workerName,
        hubAuthToken: hubAuthToken.toString("base64url"),
      });
      hubCredential = {
        schemaVersion: 1,
        role: "hub",
        hubAuthToken: hubAuthToken.toString("base64url"),
        devices: [],
      };
      hubInstallation = {
        schemaVersion: 1,
        role: "hub",
        relayUrl: provisioned.relayUrl,
        workerName: provisioned.workerName,
        accountId: provisioned.accountId,
      };
      try {
        await this.dependencies.credentialStore.save(hubCredential);
        await this.dependencies.installationStore.save(hubInstallation);
      } catch (error) {
        const cleanup = await Promise.allSettled([
          this.dependencies.credentialStore.delete(),
          installation === null
            ? this.dependencies.installationStore.delete()
            : this.dependencies.installationStore.save(installation),
          this.dependencies.deprovision({
            workerName: provisioned.workerName,
            accountId: provisioned.accountId,
          }),
        ]);
        if (cleanup.some((result) => result.status === "rejected"))
          throw new SetupCoordinatorError("SETUP_HUB_CLEANUP_FAILED");
        throw error;
      }
    }
    if (hubInstallation?.role !== "hub" || hubCredential?.role !== "hub")
      throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");

    if (
      restartRunningService ||
      (installation?.role === "hub" &&
        options.relay === true &&
        (await this.dependencies.service.status()).running)
    ) {
      if (this.dependencies.service.restart === undefined)
        throw new SetupCoordinatorError("SETUP_SERVICE_RESTART_REQUIRED");
      try {
        await this.dependencies.service.restart();
      } catch {
        throw new SetupCoordinatorError("SETUP_SERVICE_RESTART_REQUIRED");
      }
    } else await this.ensureHubService();
    const state = await this.completeWechatSetup(options);
    if (options.issueInvitation !== true) {
      return {
        ok: true,
        command: "setup",
        result: {
          role: "hub",
          relayUrl: hubInstallation.relayUrl,
          state,
        },
      };
    }
    const invitationResponse = await this.dependencies.ipc({
      command: "pairing_invitation",
    });
    const invitation = extractInvitation(invitationResponse);
    if (invitation === null)
      throw new SetupCoordinatorError("PAIRING_INVITATION_INVALID");
    return {
      ok: true,
      command: "setup",
      result: {
        role: "hub",
        relayUrl: hubInstallation.relayUrl,
        state,
        invitation,
      },
    };
  }

  private async completeWechatSetup(options: {
    loginWechat?: boolean;
    onEvent?: (event: IpcEvent) => Promise<void> | void;
    onVerifyCode?: () => Promise<string | null>;
    onAwaitingMessage?: () => Promise<void> | void;
  }): Promise<string> {
    if (options.loginWechat === false) return "ready";

    const status = await this.dependencies.ipc({ command: "status" });
    let state = extractState(status);
    if (state === null || state === "not_logged_in" || state === "auth_stale") {
      const login = await this.dependencies.ipc(
        { command: "login" },
        options.onEvent,
        options.onVerifyCode,
      );
      state = extractState(login);
      if (state === null)
        throw new SetupCoordinatorError("SETUP_LOGIN_RESPONSE_INVALID");
    }
    if (state === "awaiting_message") {
      await options.onAwaitingMessage?.();
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await this.dependencies.sleep(1_000);
        state = extractState(
          await this.dependencies.ipc({ command: "status" }),
        );
        if (state !== "awaiting_message") break;
      }
      if (state === "awaiting_message" || state === null)
        throw new SetupCoordinatorError("SETUP_INBOUND_TIMEOUT");
    }
    return state;
  }

  private async setupClient(invitation: string): Promise<SetupResult> {
    let persistedPair: SetupClientPair | null = null;
    let cleanupStarted = false;

    const rollback = async (): Promise<void> => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      const results = await Promise.allSettled([
        Promise.resolve().then(async () => {
          await this.dependencies.credentialStore.delete();
        }),
        Promise.resolve().then(async () => {
          await this.dependencies.installationStore.delete();
        }),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new SetupCoordinatorError("SETUP_CLIENT_CLEANUP_FAILED");
    };

    const persist = async (paired: SetupClientPair): Promise<void> => {
      try {
        const installation: InstallationState = {
          schemaVersion: 1,
          role: "client",
          relayUrl: paired.relayUrl,
          deviceId: paired.credential.deviceId,
        };
        await this.dependencies.credentialStore.save(paired.credential);
        await this.dependencies.installationStore.save(installation);

        const storedCredential = await this.dependencies.credentialStore.load();
        const storedInstallation =
          await this.dependencies.installationStore.load();
        if (
          !isDeepStrictEqual(storedCredential, paired.credential) ||
          !isDeepStrictEqual(storedInstallation, installation)
        )
          throw new SetupCoordinatorError("SETUP_CLIENT_READBACK_MISMATCH");

        persistedPair = structuredClone(paired);
      } catch (error) {
        await rollback();
        throw normalizeClientStorageError(error);
      }
    };

    let paired: SetupClientPair;
    try {
      paired = await this.dependencies.pairDevice(invitation, persist);
    } catch (error) {
      if (persistedPair !== null) await rollback();
      throw error;
    }

    if (persistedPair === null) {
      throw new SetupCoordinatorError("SETUP_CLIENT_PERSISTENCE_MISSING");
    }
    if (!isDeepStrictEqual(paired, persistedPair)) {
      await rollback();
      throw new SetupCoordinatorError("SETUP_CLIENT_PAIR_MISMATCH");
    }
    return {
      ok: true,
      command: "setup",
      result: {
        role: "client",
        relayUrl: paired.relayUrl,
        state: "paired",
      },
    };
  }

  private async ensureHubService(): Promise<void> {
    const status = await this.dependencies.service.status();
    if (!status.installed) await this.dependencies.service.install();
    if (!status.running) await this.dependencies.service.start();
  }
}

function normalizeClientStorageError(error: unknown): unknown {
  if (error instanceof SetupCoordinatorError) return error;
  const code = errorCode(error);
  if (
    code === "RELAY_CREDENTIAL_PERMISSIONS_UNSAFE" ||
    code === "INSTALLATION_PERMISSIONS_UNSAFE"
  )
    return error;
  return new SetupCoordinatorError("SETUP_CLIENT_STORAGE_FAILED");
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function extractState(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.state === "string") return record.state;
  if (typeof record.result !== "object" || record.result === null) return null;
  const result = record.result as Record<string, unknown>;
  if (typeof result.state === "string") return result.state;
  if (typeof result.channels !== "object" || result.channels === null)
    return null;
  const channels = result.channels as Record<string, unknown>;
  if (typeof channels.wechat !== "object" || channels.wechat === null)
    return null;
  const wechat = channels.wechat as Record<string, unknown>;
  return typeof wechat.state === "string" ? wechat.state : null;
}

function extractInvitation(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const result = (value as Record<string, unknown>).result;
  if (typeof result !== "object" || result === null) return null;
  const invitation = (result as Record<string, unknown>).invitation;
  return typeof invitation === "string" && invitation.startsWith("sw1.")
    ? invitation
    : null;
}
