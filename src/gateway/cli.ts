import { MessageConfigStore } from "../messaging/config.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { APP_VERSION } from "../app/version.js";
import { currentPlatformPaths } from "../platform/current.js";
import {
  assertLinuxServiceRuntime,
  type PlatformPaths,
} from "../platform/paths.js";
import {
  createServiceManager,
  type ServiceManager,
} from "../platform/service.js";
import type { Channel } from "../messaging/channel-router.js";
import { JsonInstallationStore } from "../storage/installation-store.js";
import { readPrivateJson, writePrivateJson } from "../storage/private-json.js";
import { gatewayPaths } from "./paths.js";
import {
  gatewayErrorCode,
  gatewayStatusSchema,
  runGateway,
} from "./runtime.js";
import {
  gatewayConfigSchema,
  gatewayStateSchema,
  type GatewayConfig,
} from "./storage.js";

export type GatewayCliDependencies = {
  paths?: PlatformPaths;
  service?: ServiceManager;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  assertHub?: () => Promise<void>;
  resolveCodex?: (value: string) => Promise<string>;
  run?: typeof runGateway;
  signal?: AbortSignal;
};

export async function resolveCodexExecutable(value: string): Promise<string> {
  const candidates =
    isAbsolute(value) || value.includes("/") || value.includes("\\")
      ? [resolve(value)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) =>
            process.platform === "win32"
              ? [join(directory, value), join(directory, `${value}.exe`)]
              : [join(directory, value)],
          );
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      if (
        process.platform === "win32" &&
        !executable.toLowerCase().endsWith(".exe")
      )
        continue;
      if (!(await stat(executable)).isFile()) continue;
      await access(
        executable,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return executable;
    } catch {
      // Continue the explicit PATH lookup; no alternate runtime is substituted.
    }
  }
  throw new Error("GATEWAY_CODEX_EXECUTABLE_NOT_FOUND");
}

function parseChannel(value: unknown): Channel {
  if (value === "wechat" || value === "feishu") return value;
  throw new Error("GATEWAY_CHANNEL_INVALID");
}

function parsePermission(value: unknown): "full" | "workspace" | "read-only" {
  if (value === "full" || value === "workspace" || value === "read-only")
    return value;
  throw new Error("GATEWAY_PERMISSION_INVALID");
}

export async function runGatewayCli(
  argv: readonly string[],
  dependencies: GatewayCliDependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const stderr =
    dependencies.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  let pathsValue: PlatformPaths | undefined;
  const hubPaths = (): PlatformPaths =>
    (pathsValue ??= dependencies.paths ?? currentPlatformPaths());
  const services = new Map<Channel, ServiceManager>();
  const service = (channel: Channel): ServiceManager => {
    const existing = services.get(channel);
    if (existing !== undefined) return existing;
    if (dependencies.service !== undefined) {
      services.set(channel, dependencies.service);
      return dependencies.service;
    }
    const hub = hubPaths();
    assertLinuxServiceRuntime(hub);
    const info = userInfo();
    const value = createServiceManager({
      platform: hub.platform,
      paths: gatewayPaths(hub, channel).service,
      nodeExecutable: process.execPath,
      cliEntry: fileURLToPath(new URL("./bin.js", import.meta.url)),
      uid: typeof process.getuid === "function" ? process.getuid() : info.uid,
      username: info.username,
      identity: {
        label: `io.github.waibiwaibig.send-message.gateway.${channel}`,
        linuxServiceName: `send-message-gateway-${channel}.service`,
        windowsTaskPrefix: `send-message-gateway-${channel}`,
        description: `send-message ${channel} Codex gateway`,
      },
      daemonArgs: ["--channel", channel, "internal-daemon"],
    });
    services.set(channel, value);
    return value;
  };
  const assertHub = async (): Promise<void> => {
    if (dependencies.assertHub !== undefined) return dependencies.assertHub();
    const installation = await new JsonInstallationStore(
      hubPaths().installationFile,
    ).load();
    if (installation?.role !== "hub" && installation?.role !== "local")
      throw new Error("GATEWAY_REQUIRES_LOCAL_HUB");
    const configuration = await new MessageConfigStore(
      hubPaths().stateDir,
    ).load();
    if (!configuration?.channels.includes(parseChannel(program.opts().channel)))
      throw new Error("CHANNEL_NOT_CONFIGURED");
  };
  const loadConfig = async (channel: Channel): Promise<GatewayConfig> => {
    const config = await readPrivateJson(
      gatewayPaths(hubPaths(), channel).config,
      gatewayConfigSchema,
    );
    if (config === null) throw new Error("GATEWAY_NOT_CONFIGURED");
    return config;
  };
  const json = argv.includes("--json");
  const success = (command: string, result: unknown): void => {
    stdout(
      json
        ? `${JSON.stringify({ schemaVersion: 1, ok: true, command, result })}\n`
        : `${command}: ${JSON.stringify(result)}\n`,
    );
  };
  const run = async (): Promise<void> => {
    await assertHub();
    const channel = parseChannel(program.opts().channel);
    const config = await loadConfig(channel);
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    if (dependencies.signal === undefined) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    try {
      await (dependencies.run ?? runGateway)(
        config,
        hubPaths(),
        dependencies.signal ?? abort.signal,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  };

  const program = new Command()
    .name("send-message-gateway")
    .description(
      "Bridge the selected channel to its persistent Codex CLI conversation.",
    )
    .version(APP_VERSION)
    .option("--json", "emit one JSON result for control commands")
    .requiredOption("--channel <channel>", "gateway channel: wechat or feishu")
    .helpCommand(false)
    .configureOutput({ writeOut: stdout, writeErr: stderr })
    .exitOverride();
  program
    .command("setup")
    .description(
      "configure and start the independent background gateway on the Hub",
    )
    .requiredOption("--cwd <directory>", "Codex working directory")
    .option("--codex <executable>", "Codex CLI executable", "codex")
    .option(
      "--permission <permission>",
      "initial Codex permission",
      "workspace",
    )
    .action(
      async (options: { cwd: string; codex: string; permission: string }) => {
        await assertHub();
        const channel = parseChannel(program.opts().channel);
        const permission = parsePermission(options.permission);
        const workingDirectory = await realpath(resolve(options.cwd));
        if (!(await stat(workingDirectory)).isDirectory())
          throw new Error("GATEWAY_CWD_INVALID");
        const existingConfig = await readPrivateJson(
          gatewayPaths(hubPaths(), channel).config,
          gatewayConfigSchema,
        );
        const config: GatewayConfig = {
          schemaVersion: 1,
          installationId: existingConfig?.installationId ?? randomUUID(),
          channel,
          permission,
          workingDirectory,
          codexExecutable: await (
            dependencies.resolveCodex ?? resolveCodexExecutable
          )(options.codex),
          searchPath: process.env.PATH ?? "",
        };
        const current = await service(channel).status();
        if (current.running) throw new Error("GATEWAY_STOP_BEFORE_SETUP");
        await writePrivateJson(
          gatewayPaths(hubPaths(), channel).config,
          gatewayConfigSchema,
          config,
        );
        await service(channel).install();
        await service(channel).start();
        success("setup", {
          channel,
          permission,
          workingDirectory,
          service: "started",
          newChatCommand: "/newchat",
        });
      },
    );
  program.command("status").action(async () => {
    const channel = parseChannel(program.opts().channel);
    const paths = gatewayPaths(hubPaths(), channel);
    const config = await readPrivateJson(paths.config, gatewayConfigSchema);
    const state = await readPrivateJson(paths.state, gatewayStateSchema);
    const runtime = await readPrivateJson(paths.status, gatewayStatusSchema);
    const serviceStatus = await service(channel).status();
    success("status", {
      channel,
      permission: config?.permission ?? null,
      configured: config !== null,
      service: serviceStatus,
      responsive:
        runtime?.phase === "ready" && Date.now() - runtime.updatedAt < 15_000,
      threadId: state?.threadId ?? null,
      runtime,
    });
  });
  program
    .command("run")
    .description("run in the foreground using the saved configuration")
    .action(run);
  program.command("internal-daemon", { hidden: true }).action(run);
  const controls = program
    .command("service")
    .description("manage only the gateway background service");
  for (const operation of [
    "install",
    "start",
    "stop",
    "restart",
    "uninstall",
  ] as const) {
    controls.command(operation).action(async () => {
      if (
        operation === "start" ||
        operation === "restart" ||
        operation === "install"
      ) {
        await assertHub();
        await loadConfig(parseChannel(program.opts().channel));
      }
      const channel = parseChannel(program.opts().channel);
      await service(channel)[operation]();
      success(`service ${operation}`, { operation, channel });
    });
  }
  try {
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw new Error("NODE_VERSION_UNSUPPORTED");
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const code =
      error instanceof CommanderError ? "USAGE_ERROR" : gatewayErrorCode(error);
    if (json)
      stdout(
        `${JSON.stringify({ schemaVersion: 1, ok: false, error: { code } })}\n`,
      );
    else stderr(`${code}\n`);
    return error instanceof CommanderError ? 2 : 5;
  }
}
