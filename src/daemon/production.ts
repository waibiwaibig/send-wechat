import { AttachmentStore } from "../messaging/attachments.js";
import {
  MessageConfigStore,
  FeishuConfigurationStore,
} from "../messaging/config.js";
import { ChannelRouter } from "../messaging/channel-router.js";
import { FeishuClient } from "../feishu/client.js";
import { FeishuReceiver } from "../feishu/receiver.js";
import { FeishuRuntime } from "../feishu/runtime.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { APP_VERSION } from "../app/version.js";
import { IlinkClient } from "../ilink/client.js";
import { loadOrCreateCapability } from "../ipc/capability.js";
import { IpcServer } from "../ipc/transport.js";
import {
  currentPlatformPaths,
  currentSupportedPlatform,
} from "../platform/current.js";
import {
  assertLinuxServiceRuntime,
  prepareOwnerDirectories,
  type PlatformPaths,
} from "../platform/paths.js";
import { RuntimeApplication } from "../runtime/application.js";
import { RelayCipher } from "../relay/crypto.js";
import { HubRelayConnection } from "../relay/hub-connection.js";
import { HubRelayConnector } from "../relay/hub-connector.js";
import { PairingInvitations } from "../relay/invitation.js";
import { PairingHub } from "../relay/pairing.js";
import { HubRelayProcessor } from "../relay/protocol.js";
import { HubRemoteFileUploads } from "../relay/uploads.js";
import { LoginCoordinator } from "../runtime/login-coordinator.js";
import { PollingCoordinator } from "../runtime/polling-coordinator.js";
import { SqliteTextInbox } from "../messaging/text-inbox.js";
import { JsonAuditLog } from "../storage/audit-log.js";
import { NativeCredentialStore } from "../storage/credential-store.js";
import { SqliteIdempotencyStore } from "../storage/idempotency-store.js";
import { JsonInstallationStore } from "../storage/installation-store.js";
import { NativeRelayCredentialStore } from "../storage/relay-credential-store.js";
import { JsonStateStore } from "../storage/state-store.js";
import { DaemonRequestRouter } from "./router.js";

type CloseableDaemon = {
  close(): Promise<void>;
};

function daemonSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export async function startProductionDaemon(
  paths: PlatformPaths = currentPlatformPaths(),
): Promise<CloseableDaemon> {
  assertLinuxServiceRuntime(paths);
  await prepareOwnerDirectories(paths, {
    platform: currentSupportedPlatform(),
  });
  const capability = await loadOrCreateCapability(paths.capabilityFile);
  const installationStore = new JsonInstallationStore(paths.installationFile);
  const relayCredentialStore = new NativeRelayCredentialStore();
  const installation = await installationStore.load();
  const relayCredential =
    installation?.role === "hub" ? await relayCredentialStore.load() : null;
  const configuration = await new MessageConfigStore(paths.stateDir).load();
  if (configuration === null) throw new Error("CHANNEL_SELECTION_REQUIRED");
  const hubInstallation = installation?.role === "hub" ? installation : null;
  const hubCredential =
    relayCredential?.role === "hub" ? relayCredential : null;
  if ((hubInstallation === null) !== (hubCredential === null))
    throw new Error("RELAY_INSTALLATION_INCONSISTENT");
  const stateStore = new JsonStateStore(paths.stateFile);
  const credentialStore = new NativeCredentialStore();
  const idempotencyStore = new SqliteIdempotencyStore(paths.idempotencyFile);
  const inbox = new SqliteTextInbox(join(paths.stateDir, "text-inbox.sqlite"));
  const ilink = new IlinkClient({
    productVersion: APP_VERSION,
    sleep: daemonSleep,
  });
  const audit = new JsonAuditLog({ directory: paths.logDir });
  const runtime = new RuntimeApplication({
    clock: { now: Date.now },
    stateStore,
    credentialStore,
    idempotencyStore,
    ilink,
    audit,
  });
  const login = new LoginCoordinator({
    stateStore,
    credentialStore,
    ilink,
    clock: { now: Date.now },
    sleep: daemonSleep,
  });
  const attachments = new AttachmentStore(
    join(paths.stateDir, "inbound-attachments"),
  );
  const polling = new PollingCoordinator({
    stateStore,
    credentialStore,
    ilink,
    runtime,
    clock: { now: Date.now },
    sleep: daemonSleep,
    random: Math.random,
    inbox,
    receiveAttachments: async (message) => {
      if (!inbox.isActive()) return [];
      const result = [];
      for (const attachment of message.attachments ?? []) {
        const path = await attachments.save(
          attachment.fileName,
          async (destination) =>
            ilink.downloadInboundAttachment(attachment, destination),
        );
        result.push({
          type: attachment.type,
          path,
          fileName: attachment.fileName,
        });
      }
      return result;
    },
  });
  const feishuSecret = configuration.channels.includes("feishu")
    ? await new FeishuConfigurationStore(paths.stateDir).load()
    : null;
  if (configuration.channels.includes("feishu") && feishuSecret === null)
    throw new Error("FEISHU_CONFIGURATION_REQUIRED");
  const feishu =
    feishuSecret === null
      ? null
      : new FeishuClient(feishuSecret, paths.stateDir);
  const feishuInbox = new SqliteTextInbox(
    join(paths.stateDir, "feishu-inbox.sqlite"),
  );
  const feishuReceiver =
    feishu === null
      ? null
      : new FeishuReceiver(feishu, feishuInbox, attachments);
  const channels = new ChannelRouter({
    defaultChannel: configuration.defaultChannel,
    providers: {
      ...(configuration.channels.includes("wechat") ? { wechat: runtime } : {}),
      ...(feishu === null
        ? {}
        : {
            feishu: new FeishuRuntime(
              feishu,
              new SqliteIdempotencyStore(
                join(paths.stateDir, "feishu-idempotency.sqlite"),
              ),
              () => {
                const inbound = feishu.getInboundDiagnostics();
                return {
                  ...feishuReceiver!.diagnostics(),
                  lastEventAt: inbound.lastEventAt,
                  lastFilterReason: inbound.lastFilterReason,
                  lastProcessingError: inbound.lastInboundError,
                };
              },
            ),
          }),
    },
  });
  const invitations = new PairingInvitations();
  const router = new DaemonRequestRouter({
    runtime: channels,
    inboxes: { wechat: inbox, feishu: feishuInbox },
    login,
    withPollingPaused: (operation) => polling.withPollingPaused(operation),
    issuePairingInvitation: () => {
      if (hubInstallation === null) throw new Error("HUB_NOT_CONFIGURED");
      return invitations.issue(hubInstallation.relayUrl);
    },
    inbox,
    doctor: async () => {
      let state: "absent" | "valid" | "invalid" = "absent";
      try {
        state = (await stateStore.load()) === null ? "absent" : "valid";
      } catch {
        state = "invalid";
      }
      let idempotencyLedger: "valid" | "invalid" = "valid";
      try {
        await idempotencyStore.find("doctor");
      } catch {
        idempotencyLedger = "invalid";
      }
      let credentialStoreStatus: "available" | "invalid" | "unavailable" =
        "available";
      try {
        if (configuration.channels.includes("wechat"))
          await credentialStore.load();
        if (feishu !== null) await feishu.verify();
      } catch (error) {
        const code =
          error instanceof Error && "code" in error ? String(error.code) : "";
        credentialStoreStatus = code.includes("SCHEMA")
          ? "invalid"
          : "unavailable";
      }
      const ok =
        state !== "invalid" &&
        idempotencyLedger === "valid" &&
        credentialStoreStatus === "available";
      return {
        ok,
        ...(ok
          ? {}
          : {
              error: {
                code: "DAEMON_CHECK_FAILED",
                retryable: false,
              },
            }),
        checks: {
          state,
          idempotencyLedger,
          credentialStore: credentialStoreStatus,
          protocol: "pinned",
        },
      };
    },
  });
  const server = new IpcServer({
    endpoint: paths.ipcEndpoint,
    tempDir: paths.tempDir,
    capability,
    appVersion: APP_VERSION,
    handle: (request, context) => router.handle(request, context),
  });
  const abort = new AbortController();
  await server.start();
  let receiverTask = Promise.resolve();
  const receiverTimer = setInterval(() => {
    if (!abort.signal.aborted && feishuReceiver !== null)
      receiverTask = feishuReceiver.tick().catch(() => undefined);
  }, 1000);
  receiverTimer.unref();
  const pollingTask = configuration.channels.includes("wechat")
    ? polling.run(abort.signal)
    : Promise.resolve();
  let relayConnector: HubRelayConnector | null = null;
  let relayUploads: HubRemoteFileUploads | null = null;
  if (hubInstallation !== null && hubCredential !== null) {
    const cipher = new RelayCipher();
    const pairing = new PairingHub({
      invitations,
      credentialStore: relayCredentialStore,
      cipher,
    });
    const relayContext = {
      emit: () => Promise.resolve(),
      requestVerifyCode: () => Promise.resolve(null),
    };
    relayUploads = new HubRemoteFileUploads({
      temporaryDirectory: paths.tempDir,
      requestId: randomUUID,
      deliver: async (request) => router.handle(request, relayContext),
    });
    const uploads = relayUploads;
    const processor = new HubRelayProcessor({
      cipher,
      credentialStore: relayCredentialStore,
      pairing,
      execute: async (command, { deviceId }) => {
        const requestId = randomUUID();
        if (command.command === "status")
          return router.handle({ command: "status", requestId }, relayContext);
        if (command.command === "send_text")
          return router.handle(
            {
              command: "send_text",
              requestId,
              idempotencyKey: command.idempotencyKey,
              text: command.text,
              ...(command.channel === undefined
                ? {}
                : { channel: command.channel }),
            },
            relayContext,
          );
        return uploads.execute(deviceId, command);
      },
    });
    relayConnector = new HubRelayConnector({
      relayUrl: hubInstallation.relayUrl,
      hubAuthToken: hubCredential.hubAuthToken,
      connection: new HubRelayConnection(processor),
    });
    relayConnector.start();
  }

  return {
    async close() {
      abort.abort();
      clearInterval(receiverTimer);
      await receiverTask;
      await feishuReceiver?.close();
      feishuInbox.close();
      await relayConnector?.stop();
      await relayUploads?.close();
      await server.close();
      await pollingTask;
      inbox.close();
      await rm(paths.tempDir, { recursive: true, force: true });
    },
  };
}

export async function runProductionDaemon(): Promise<void> {
  const daemon = await startProductionDaemon();
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await daemon.close();
}
