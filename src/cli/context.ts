import {
  randomBytes as cryptoRandomBytes,
  randomUUID as cryptoRandomUUID,
} from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";

import * as QRCode from "qrcode";

import { APP_VERSION } from "../app/version.js";
import { runProductionDaemon } from "../daemon/production.js";
import { resetOwnerData } from "../daemon/reset.js";
import { loadCapability, loadOrCreateCapability } from "../ipc/capability.js";
import {
  IpcTransportError,
  requestIpc,
  type IpcClientPayload,
  type IpcEvent,
  type RequestIpcOptions,
} from "../ipc/transport.js";
import { currentPlatformPaths } from "../platform/current.js";
import {
  prepareOwnerDirectories,
  type PlatformPaths,
  type SupportedPlatform,
} from "../platform/paths.js";
import {
  createServiceManager,
  type ServiceManager,
  type ServiceManagerDependencies,
} from "../platform/service.js";
import {
  CloudflareProvisioner,
  CloudflareProvisioningError,
  type CloudflareAccount,
} from "../relay/cloudflare.js";
import { PairingClient } from "../relay/pairing.js";
import {
  RelayHttpTransport,
  RelayProtocolError,
  RemoteRelayClient,
} from "../relay/protocol.js";
import { RemoteFileSender } from "../relay/uploads.js";
import {
  SetupCoordinator,
  SetupCoordinatorError,
} from "../setup/coordinator.js";
import { NativeCredentialStore } from "../storage/credential-store.js";
import { JsonInstallationStore } from "../storage/installation-store.js";
import { NativeRelayCredentialStore } from "../storage/relay-credential-store.js";
import {
  type CliDependencies,
  type CliIO,
  type QrRenderer,
  type SetupOptions,
  isRecord,
  writeOutput,
} from "./contracts.js";

function defaultIO(): CliIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function defaultCliEntryPath(): string {
  const current = fileURLToPath(import.meta.url);
  if (current.includes(`${sep}dist${sep}`)) {
    return resolve(dirname(current), "bin.js");
  }
  return resolve(dirname(current), "../../dist/cli/bin.js");
}

export class CliContext {
  private readonly io: CliIO;
  private pathsValue: PlatformPaths | undefined;
  private platformValue: SupportedPlatform | undefined;
  private serviceValue: ServiceManager | undefined;
  private readonly createdQrFiles = new Set<string>();
  private language: "zh-CN" | "en" = "zh-CN";

  public constructor(private readonly dependencies: CliDependencies) {
    this.io = dependencies.io ?? defaultIO();
  }

  public output(): CliIO {
    return this.io;
  }
  public setLanguage(language: "zh-CN" | "en"): void {
    this.language = language;
  }
  public nodeVersion(): string {
    return this.dependencies.nodeVersion ?? process.versions.node;
  }
  public randomUUID(): string {
    return (this.dependencies.randomUUID ?? cryptoRandomUUID)();
  }

  public getPaths(): PlatformPaths {
    if (this.pathsValue === undefined) {
      this.pathsValue =
        this.dependencies.paths ??
        (this.dependencies.currentPlatformPaths ?? currentPlatformPaths)();
    }
    return this.pathsValue;
  }

  public getPlatform(): SupportedPlatform {
    if (this.platformValue === undefined) {
      this.platformValue =
        this.dependencies.currentSupportedPlatform === undefined
          ? this.getPaths().platform
          : this.dependencies.currentSupportedPlatform();
    }
    return this.platformValue;
  }

  public getServiceManager(): ServiceManager {
    if (this.serviceValue !== undefined) return this.serviceValue;
    if (this.dependencies.serviceManager !== undefined) {
      this.serviceValue = this.dependencies.serviceManager;
      return this.serviceValue;
    }
    const info = userInfo();
    const uid =
      typeof process.getuid === "function" ? process.getuid() : info.uid;
    const serviceDependencies: ServiceManagerDependencies = {
      platform: this.getPlatform(),
      paths: this.getPaths(),
      nodeExecutable: process.execPath,
      cliEntry: this.dependencies.cliEntry ?? defaultCliEntryPath(),
      uid,
      username: info.username,
    };
    this.serviceValue = (
      this.dependencies.createServiceManager ?? createServiceManager
    )(serviceDependencies);
    return this.serviceValue;
  }

  public async capability(): Promise<string> {
    return await (this.dependencies.loadCapability ?? loadCapability)(
      this.getPaths().capabilityFile,
    );
  }

  public async ipc(
    payload: IpcClientPayload,
    filePath?: string,
    onEvent?: (event: IpcEvent) => Promise<void> | void,
    onVerifyCode?: () => Promise<string | null>,
    knownCapability?: string,
  ): Promise<unknown> {
    const requestId = this.randomUUID();
    const options: RequestIpcOptions = {
      endpoint: this.getPaths().ipcEndpoint,
      capability: knownCapability ?? (await this.capability()),
      appVersion: APP_VERSION,
      requestId,
      payload,
      ...(filePath === undefined ? {} : { filePath }),
      ...(onEvent === undefined ? {} : { onEvent }),
      ...(onVerifyCode === undefined ? {} : { onVerifyCode }),
    };
    const result = await (this.dependencies.requestIpc ?? requestIpc)(options);
    return isRecord(result) && result.requestId === undefined
      ? { ...result, requestId }
      : result;
  }

  public async dispatch(
    payload: IpcClientPayload,
    filePath?: string,
  ): Promise<unknown> {
    if (this.dependencies.dispatch !== undefined)
      return await this.dependencies.dispatch(payload, filePath);
    const installation = await new JsonInstallationStore(
      this.getPaths().installationFile,
    ).load();
    if (installation === null || installation.role === "hub")
      return await this.ipc(payload, filePath);
    const credential = await new NativeRelayCredentialStore().load();
    if (
      credential === null ||
      credential.role !== "client" ||
      credential.deviceId !== installation.deviceId
    )
      throw new SetupCoordinatorError("INSTALLATION_INCONSISTENT");
    if (
      payload.command !== "status" &&
      payload.command !== "send_text" &&
      payload.command !== "send_file"
    )
      throw new RelayProtocolError("REMOTE_COMMAND_UNSUPPORTED");
    const client = new RemoteRelayClient({
      relayUrl: installation.relayUrl,
      credential,
      transport: new RelayHttpTransport(),
    });
    if (payload.command === "send_file") {
      if (filePath === undefined) throw new RelayProtocolError("FILE_REQUIRED");
      return await new RemoteFileSender({
        execute: async (command) => await client.execute(command),
      }).send({
        filePath,
        fileName: payload.fileName,
        byteLength: payload.byteLength,
        idempotencyKey: payload.idempotencyKey,
      });
    }
    return await client.execute(
      payload.command === "status"
        ? { command: "status" }
        : {
            command: "send_text",
            idempotencyKey: payload.idempotencyKey,
            text: payload.text,
          },
    );
  }

  public async installation() {
    return await new JsonInstallationStore(
      this.getPaths().installationFile,
    ).load();
  }

  public async assertHubServiceOperation(): Promise<void> {
    if ((await this.installation())?.role === "client")
      throw new SetupCoordinatorError("CLIENT_HAS_NO_SERVICE");
  }

  public async readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of this.io.stdin as AsyncIterable<
      Uint8Array | string
    >) {
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > 16_000) {
        const error = new Error("INVALID_TEXT") as Error & { code: string };
        error.code = "INVALID_TEXT";
        throw error;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private stdinIsTTY(): boolean {
    return (
      (this.io.stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY ===
      true
    );
  }

  public async verifyCode(): Promise<string | null> {
    if (this.dependencies.promptVerifyCode !== undefined)
      return await this.dependencies.promptVerifyCode();
    if (!this.stdinIsTTY()) return null;
    await writeOutput(
      this.io.stderr,
      this.language === "zh-CN" ? "验证码：" : "Verification code: ",
    );
    const readline = createInterface({
      input: this.io.stdin,
      output: this.io.stderr,
    });
    try {
      return await readline.question("");
    } finally {
      readline.close();
    }
  }

  public async confirmReset(): Promise<string | null> {
    if (this.dependencies.promptReset !== undefined)
      return await this.dependencies.promptReset();
    if (!this.stdinIsTTY()) return null;
    await writeOutput(
      this.io.stderr,
      this.language === "zh-CN"
        ? "输入 RESET 继续："
        : "Type RESET to continue: ",
    );
    const readline = createInterface({
      input: this.io.stdin,
      output: this.io.stderr,
    });
    try {
      return await readline.question("");
    } finally {
      readline.close();
    }
  }

  public async setup(options: SetupOptions): Promise<unknown> {
    let awaitingMessagePromptShown = false;
    const onAwaitingMessage = async (): Promise<void> => {
      if (awaitingMessagePromptShown) return;
      awaitingMessagePromptShown = true;
      await writeOutput(
        this.io.stderr,
        this.language === "zh-CN"
          ? "扫码成功。请现在向这个 bot 发送任意消息；bot 不会回复，收到后 setup 会自动继续。\n"
          : "QR login confirmed. Send any message to this bot now; it will not reply, and setup will continue automatically once received.\n",
      );
    };
    const onEvent = async (event: IpcEvent): Promise<void> => {
      if (event.type === "qr")
        await this.renderQr(event.content, options.qrFile);
      else if (event.type === "login_state") {
        await this.emitLoginState(event.state);
        if (event.state === "confirmed") await onAwaitingMessage();
      }
    };
    const onVerifyCode = async (): Promise<string | null> =>
      await this.verifyCode();
    if (this.dependencies.setup !== undefined)
      return await this.dependencies.setup(
        options,
        onEvent,
        onVerifyCode,
        onAwaitingMessage,
      );

    const paths = this.getPaths();
    const provisioner = new CloudflareProvisioner({
      temporaryRoot: paths.tempDir,
      selectAccount: async (accounts) =>
        await this.selectCloudflareAccount(accounts),
      onProgress: async ({ attempt, maxAttempts }) => {
        const message =
          attempt === 1
            ? this.language === "zh-CN"
              ? "正在验证个人 Relay；验证完成后将显示二维码…\n"
              : "Verifying the personal relay; the QR code comes next…\n"
            : this.language === "zh-CN"
              ? `个人 Relay 暂未可达，正在重试（${attempt}/${maxAttempts}）…\n`
              : `The personal relay is not reachable yet; retrying (${attempt}/${maxAttempts})…\n`;
        await writeOutput(this.io.stderr, message);
      },
    });
    const coordinator = new SetupCoordinator({
      installationStore: new JsonInstallationStore(paths.installationFile),
      credentialStore: new NativeRelayCredentialStore(),
      prepare: async () => await this.prepareInstall(),
      provision: async (input) => await provisioner.provision(input),
      deprovision: async (input) => await provisioner.deprovision(input),
      service: this.getServiceManager(),
      ipc: async (payload, eventHandler, verifyCode) =>
        await this.setupIpc(payload, eventHandler, verifyCode),
      pairDevice: async (invitation) => {
        const pairing = new PairingClient();
        const attempt = pairing.begin(invitation);
        const transport = new RelayHttpTransport();
        let response: Awaited<ReturnType<typeof transport.exchange>> | null =
          null;
        for (let retry = 0; retry < 8; retry += 1) {
          try {
            response = await transport.exchange(
              attempt.relayUrl,
              attempt.requestFrame,
            );
            break;
          } catch (error) {
            const retryable =
              error instanceof RelayProtocolError &&
              (error.retryable || error.code === "HUB_OFFLINE");
            if (!retryable || retry === 7) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(2_000, 250 * 2 ** retry)),
            );
          }
        }
        if (response === null)
          throw new RelayProtocolError("RELAY_UNAVAILABLE", true);
        return {
          relayUrl: attempt.relayUrl,
          credential: pairing.complete(attempt, response.frame),
        };
      },
      randomBytes: cryptoRandomBytes,
      sleep: async (milliseconds) =>
        await new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    return await coordinator.setup({
      ...(options.pair === undefined ? {} : { pair: options.pair }),
      onEvent,
      onVerifyCode,
      onAwaitingMessage,
    });
  }

  public async renderQr(
    content: string,
    qrFile: string | undefined,
  ): Promise<void> {
    const renderer: QrRenderer = this.dependencies.qrRenderer ?? {
      terminal:
        this.dependencies.renderQrTerminal ??
        (async (value: string) =>
          await QRCode.toString(value, { type: "terminal", small: true })),
      png:
        this.dependencies.writeQrPng ??
        (async (path: string, value: string) => {
          await this.writeQrPng(path, value);
        }),
    };
    if (qrFile === undefined) {
      await writeOutput(
        this.io.stderr,
        `${await renderer.terminal(content)}\n`,
      );
    } else {
      await renderer.png(qrFile, content);
    }
  }

  public async emitLoginState(state: string): Promise<void> {
    await writeOutput(this.io.stderr, `login: ${state}\n`);
  }

  public async prepareInstall(): Promise<void> {
    const paths = this.getPaths();
    await (
      this.dependencies.prepareOwnerDirectories ?? prepareOwnerDirectories
    )(paths, { platform: this.getPlatform() });
    await (this.dependencies.loadOrCreateCapability ?? loadOrCreateCapability)(
      paths.capabilityFile,
    );
  }

  public async reset(): Promise<void> {
    if (this.dependencies.reset !== undefined) {
      await this.dependencies.reset(this.getPaths());
      return;
    }
    if (this.dependencies.resetOwnerData !== undefined) {
      await this.dependencies.resetOwnerData(this.getPaths());
      return;
    }
    await resetOwnerData(this.getPaths(), {
      credentialStore: new NativeCredentialStore(),
      relayCredentialStore: new NativeRelayCredentialStore(),
    });
  }

  public async deprovisionRelay(): Promise<void> {
    if (this.dependencies.deprovisionRelay !== undefined) {
      await this.dependencies.deprovisionRelay();
      return;
    }
    const paths = this.getPaths();
    const installation = await new JsonInstallationStore(
      paths.installationFile,
    ).load();
    if (installation?.role !== "hub") return;
    await new CloudflareProvisioner({
      temporaryRoot: paths.tempDir,
    }).deprovision({
      workerName: installation.workerName,
      accountId: installation.accountId,
    });
  }

  public async runDaemon(): Promise<void> {
    await (this.dependencies.runProductionDaemon ?? runProductionDaemon)();
  }

  private async setupIpc(
    payload: IpcClientPayload,
    onEvent?: (event: IpcEvent) => Promise<void> | void,
    onVerifyCode?: () => Promise<string | null>,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.ipc(payload, undefined, onEvent, onVerifyCode);
      } catch (error) {
        if (
          !(error instanceof IpcTransportError) ||
          error.code !== "IPC_UNAVAILABLE" ||
          attempt >= 19
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private async selectCloudflareAccount(
    accounts: readonly CloudflareAccount[],
  ): Promise<string> {
    if (this.dependencies.promptCloudflareAccount !== undefined)
      return await this.dependencies.promptCloudflareAccount(accounts);
    if (!this.stdinIsTTY())
      throw new CloudflareProvisioningError(
        "CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED",
        accounts,
      );
    await writeOutput(
      this.io.stderr,
      `${this.language === "zh-CN" ? "选择 Cloudflare 账户" : "Select a Cloudflare account"}:\n${accounts
        .map(({ name }, index) => `  ${index + 1}. ${name}`)
        .join("\n")}\n> `,
    );
    const readline = createInterface({
      input: this.io.stdin,
      output: this.io.stderr,
    });
    try {
      const answer = await readline.question("");
      const selected = Number(answer.trim());
      if (
        !Number.isInteger(selected) ||
        selected < 1 ||
        selected > accounts.length
      )
        throw new CloudflareProvisioningError(
          "CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED",
          accounts,
        );
      return accounts[selected - 1]!.id;
    } finally {
      readline.close();
    }
  }

  private async writeQrPng(path: string, content: string): Promise<void> {
    const resolvedPath = resolve(path);
    const png = await QRCode.toBuffer(content, { type: "png" });
    if (!this.createdQrFiles.has(resolvedPath)) {
      let handle;
      try {
        handle = await open(resolvedPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const publicError = new Error("QR_FILE_EXISTS") as Error & {
            code: string;
          };
          publicError.code = "QR_FILE_EXISTS";
          throw publicError;
        }
        throw error;
      }
      try {
        await handle.writeFile(png);
        await handle.sync();
        await handle.close();
        if (process.platform !== "win32") await chmod(resolvedPath, 0o600);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(resolvedPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
      this.createdQrFiles.add(resolvedPath);
      return;
    }

    const temporaryPath = `${resolvedPath}.${this.randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(png);
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, resolvedPath);
      if (process.platform !== "win32") await chmod(resolvedPath, 0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function createContext(dependencies: CliDependencies): CliContext {
  return new CliContext(dependencies);
}
