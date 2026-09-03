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
      };
      readonly ipc: (
        payload: IpcClientPayload,
        onEvent?: (event: IpcEvent) => Promise<void> | void,
        onVerifyCode?: () => Promise<string | null>,
      ) => Promise<unknown>;
      readonly pairDevice: (invitation: string) => Promise<{
        relayUrl: string;
        credential: ClientRelayCredential;
      }>;
      readonly randomBytes: (size: number) => Buffer;
      readonly sleep: (milliseconds: number) => Promise<void>;
    },
  ) {}

  public async setup(options: {
    pair?: string;
    issueInvitation?: boolean;
    onEvent?: (event: IpcEvent) => Promise<void> | void;
    onVerifyCode?: () => Promise<string | null>;
    onAwaitingMessage?: () => Promise<void> | void;
  }): Promise<SetupResult> {
    const [installation, credential] = await Promise.all([
      this.dependencies.installationStore.load(),
      this.dependencies.credentialStore.load(),
    ]);
    if ((installation === null) !== (credential === null))
      throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");

    if (options.pair !== undefined) {
      if (installation !== null)
        throw new SetupCoordinatorError("INSTALLATION_ALREADY_CONFIGURED");
      return await this.setupClient(options.pair);
    }
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

    await this.dependencies.prepare();
    let hubInstallation = installation;
    let hubCredential = credential;
    const freshHub = hubInstallation === null && hubCredential === null;
    if (hubInstallation === null && hubCredential === null) {
      const suffix = this.dependencies.randomBytes(4);
      const hubAuthToken = this.dependencies.randomBytes(32);
      if (suffix.byteLength !== 4 || hubAuthToken.byteLength !== 32)
        throw new SetupCoordinatorError("SETUP_RANDOM_INVALID");
      const workerName = `send-wechat-${suffix.toString("hex")}`;
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
        await Promise.allSettled([
          this.dependencies.credentialStore.delete(),
          this.dependencies.installationStore.delete(),
          this.dependencies.deprovision({
            workerName: provisioned.workerName,
            accountId: provisioned.accountId,
          }),
        ]);
        throw error;
      }
    }
    if (hubInstallation?.role !== "hub" || hubCredential?.role !== "hub")
      throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");

    await this.ensureHubService();
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
    if (freshHub || options.issueInvitation !== true) {
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

  private async setupClient(invitation: string): Promise<SetupResult> {
    const paired = await this.dependencies.pairDevice(invitation);
    const installation: InstallationState = {
      schemaVersion: 1,
      role: "client",
      relayUrl: paired.relayUrl,
      deviceId: paired.credential.deviceId,
    };
    try {
      await this.dependencies.credentialStore.save(paired.credential);
      await this.dependencies.installationStore.save(installation);
    } catch (error) {
      await Promise.allSettled([
        this.dependencies.credentialStore.delete(),
        this.dependencies.installationStore.delete(),
      ]);
      throw error;
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

function extractState(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.state === "string") return record.state;
  if (typeof record.result !== "object" || record.result === null) return null;
  const result = record.result as Record<string, unknown>;
  return typeof result.state === "string" ? result.state : null;
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
