import {
  access,
  chmod,
  mkdir,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  defaultCommandRunner,
  runWithCommandRunner,
  type CommandRunnerLike,
  type CommandResult,
} from "./command.js";
import {
  PlatformCommandError,
  UnsupportedPlatformError,
  type PlatformPaths,
  type SupportedPlatform,
} from "./paths.js";

const SERVICE_LABEL = "io.github.waibiwaibig.send-wechat";
const LINUX_SERVICE_NAME = "send-wechat.service";

export type ServiceStatus = {
  installed: boolean;
  running: boolean;
};

export interface ServiceManager {
  status(): Promise<ServiceStatus>;
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  uninstall(): Promise<void>;
}

export type ServiceManagerDependencies = {
  readonly platform: SupportedPlatform;
  readonly paths: PlatformPaths;
  readonly nodeExecutable: string;
  readonly cliEntry: string;
  readonly uid: string | number;
  readonly username: string;
  readonly commandRunner?: CommandRunnerLike;
  readonly runCommand?: CommandRunnerLike;
  readonly runner?: CommandRunnerLike;
};

type CommandFailure = Error & {
  readonly code?: string | number;
  readonly stderr?: string;
  readonly stdout?: string;
};

function commandFailureMessage(result: CommandResult): string {
  return result.stderr || result.stdout || `exit ${result.exitCode}`;
}

function isUnavailable(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("failed to connect to bus") ||
    output.includes("not been booted")
  );
}

function rethrowUnavailable(
  platform: SupportedPlatform,
  command: string,
  error: unknown,
): never {
  const candidate = error as CommandFailure;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  if (
    platform === "linux" &&
    (candidate.code === "ENOENT" ||
      candidate.code === 127 ||
      candidate.stderr?.toLowerCase().includes("failed to connect to bus") ===
        true ||
      message.includes("enoent") ||
      message.includes("command not found"))
  ) {
    throw new UnsupportedPlatformError(
      `Linux systemd user manager is unavailable (${command})`,
    );
  }
  throw error;
}

function assertCommandSucceeded(
  platform: SupportedPlatform,
  command: string,
  result: CommandResult,
): void {
  if (result.exitCode === 0) return;
  if (platform === "linux" && isUnavailable(result)) {
    throw new UnsupportedPlatformError(
      `Linux systemd user manager is unavailable (${command})`,
    );
  }
  throw new PlatformCommandError(
    `${command} failed: ${commandFailureMessage(result)}`,
  );
}

async function runCommand(
  runner: CommandRunnerLike,
  platform: SupportedPlatform,
  file: string,
  args: readonly string[],
): Promise<CommandResult> {
  try {
    return await runWithCommandRunner(runner, file, args, { shell: false });
  } catch (error) {
    rethrowUnavailable(platform, `${file} ${args.join(" ")}`, error);
  }
}

async function configExists(configPath: string): Promise<boolean> {
  try {
    await access(configPath);
    return true;
  } catch {
    return false;
  }
}

async function writeOwnerConfig(
  configPath: string,
  contents: string,
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeConfig(configPath: string): Promise<void> {
  try {
    await unlink(configPath);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code !== "ENOENT") throw error;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchAgentDefinition(
  nodeExecutable: string,
  cliEntry: string,
): string {
  const argumentsXml = [nodeExecutable, cliEntry, "internal-daemon"]
    .map((argument) => `\t\t\t<string>${xmlEscape(argument)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${SERVICE_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    argumentsXml,
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "\t<key>ThrottleInterval</key>",
    "\t<integer>5</integer>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function systemdEscape(value: string): string {
  let escaped = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (character === "%") escaped += "%%";
    else if (code === 0x09) escaped += "\\x09";
    else if (code === 0x0a) escaped += "\\x0a";
    else if (code === 0x0d) escaped += "\\x0d";
    else if (code < 0x20 || code === 0x7f)
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return `${escaped}"`;
}

function systemdUnitDefinition(
  nodeExecutable: string,
  cliEntry: string,
): string {
  return [
    "[Unit]",
    "Description=send-wechat daemon",
    "",
    "[Service]",
    `ExecStart=${[nodeExecutable, cliEntry].map(systemdEscape).join(" ")} internal-daemon`,
    "Restart=on-failure",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function powerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsCommandLineArgument(value: string): string {
  let output = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat(backslashes * 2 + 1);
      output += '"';
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes);
    output += character;
    backslashes = 0;
  }
  output += "\\".repeat(backslashes * 2);
  return `${output}"`;
}

function scheduledTaskRegistration(
  nodeExecutable: string,
  cliEntry: string,
  taskName: string,
): string {
  const actionArgument = `${windowsCommandLineArgument(cliEntry)} internal-daemon`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$action = New-ScheduledTaskAction -Execute ${powerShellSingleQuoted(nodeExecutable)} -Argument ${powerShellSingleQuoted(actionArgument)}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser",
    "$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskName ${powerShellSingleQuoted(taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force`,
    "",
  ].join("\n");
}

function powershellControl(command: string): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ];
}

function taskStatusCommand(taskName: string): string {
  return [
    `$task = Get-ScheduledTask -TaskName ${powerShellSingleQuoted(taskName)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { exit 3 }",
    'if ($task.State -eq "Running") { exit 0 }',
    "exit 1",
  ].join("; ");
}

function createManager(
  dependencies: ServiceManagerDependencies,
): ServiceManager {
  const { platform, paths, nodeExecutable, cliEntry, uid, username } =
    dependencies;
  if (paths.platform !== platform) {
    throw new UnsupportedPlatformError(
      `service platform ${platform} does not match paths ${paths.platform}`,
    );
  }
  const runner =
    dependencies.commandRunner ??
    dependencies.runCommand ??
    dependencies.runner ??
    defaultCommandRunner;
  const launchTarget = `gui/${String(uid)}/${SERVICE_LABEL}`;
  const windowsTaskName = `send-wechat-${createHash("sha256")
    .update(
      `${username.toLowerCase()}\0${path.win32.resolve(paths.stateDir).toLowerCase()}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 16)}`;

  async function status(): Promise<ServiceStatus> {
    if (platform === "darwin") {
      const installed = await configExists(paths.serviceConfigPath);
      if (!installed) return { installed: false, running: false };
      const result = await runCommand(runner, platform, "launchctl", [
        "print",
        launchTarget,
      ]);
      return { installed: true, running: result.exitCode === 0 };
    }

    if (platform === "linux") {
      const enabled = await runCommand(runner, platform, "systemctl", [
        "--user",
        "is-enabled",
        LINUX_SERVICE_NAME,
      ]);
      if (enabled.exitCode !== 0 && isUnavailable(enabled)) {
        throw new UnsupportedPlatformError(
          "Linux systemd user manager is unavailable",
        );
      }
      const configInstalled = await configExists(paths.serviceConfigPath);
      if (!configInstalled && enabled.exitCode !== 0)
        return { installed: false, running: false };
      const active = await runCommand(runner, platform, "systemctl", [
        "--user",
        "is-active",
        LINUX_SERVICE_NAME,
      ]);
      if (active.exitCode !== 0 && isUnavailable(active)) {
        throw new UnsupportedPlatformError(
          "Linux systemd user manager is unavailable",
        );
      }
      return { installed: true, running: active.exitCode === 0 };
    }

    const result = await runCommand(
      runner,
      platform,
      "powershell.exe",
      powershellControl(taskStatusCommand(windowsTaskName)),
    );
    if (result.exitCode === 3) return { installed: false, running: false };
    if (result.exitCode === 0) return { installed: true, running: true };
    if (result.exitCode === 1) return { installed: true, running: false };
    throw new PlatformCommandError(
      `Scheduled Task status failed: ${commandFailureMessage(result)}`,
    );
  }

  async function install(): Promise<void> {
    if (platform === "darwin") {
      await writeOwnerConfig(
        paths.serviceConfigPath,
        launchAgentDefinition(nodeExecutable, cliEntry),
      );
      return;
    }

    if (platform === "linux") {
      await writeOwnerConfig(
        paths.serviceConfigPath,
        systemdUnitDefinition(nodeExecutable, cliEntry),
      );
      const reload = await runCommand(runner, platform, "systemctl", [
        "--user",
        "daemon-reload",
      ]);
      assertCommandSucceeded(
        platform,
        "systemctl --user daemon-reload",
        reload,
      );
      const enable = await runCommand(runner, platform, "systemctl", [
        "--user",
        "enable",
        LINUX_SERVICE_NAME,
      ]);
      assertCommandSucceeded(platform, "systemctl --user enable", enable);
      return;
    }

    await writeOwnerConfig(
      paths.serviceConfigPath,
      scheduledTaskRegistration(nodeExecutable, cliEntry, windowsTaskName),
    );
    const result = await runCommand(runner, platform, "powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      paths.serviceConfigPath,
    ]);
    assertCommandSucceeded(
      platform,
      "PowerShell Scheduled Task registration",
      result,
    );
  }

  async function start(): Promise<void> {
    if (platform === "darwin") {
      if (!(await configExists(paths.serviceConfigPath))) {
        throw new PlatformCommandError("LaunchAgent is not installed");
      }
      const loaded = await runCommand(runner, platform, "launchctl", [
        "print",
        launchTarget,
      ]);
      if (loaded.exitCode === 0) {
        const result = await runCommand(runner, platform, "launchctl", [
          "kickstart",
          launchTarget,
        ]);
        assertCommandSucceeded(platform, "launchctl kickstart", result);
      } else {
        const result = await runCommand(runner, platform, "launchctl", [
          "bootstrap",
          `gui/${String(uid)}`,
          paths.serviceConfigPath,
        ]);
        assertCommandSucceeded(platform, "launchctl bootstrap", result);
      }
    } else if (platform === "linux") {
      const result = await runCommand(runner, platform, "systemctl", [
        "--user",
        "start",
        LINUX_SERVICE_NAME,
      ]);
      assertCommandSucceeded(platform, "systemctl --user start", result);
    } else {
      const result = await runCommand(
        runner,
        platform,
        "powershell.exe",
        powershellControl(
          `Start-ScheduledTask -TaskName ${powerShellSingleQuoted(windowsTaskName)}`,
        ),
      );
      assertCommandSucceeded(platform, "Start-ScheduledTask", result);
    }
  }

  async function stop(): Promise<void> {
    if (platform === "darwin") {
      const loaded = await runCommand(runner, platform, "launchctl", [
        "print",
        launchTarget,
      ]);
      if (loaded.exitCode !== 0) return;
      const result = await runCommand(runner, platform, "launchctl", [
        "bootout",
        launchTarget,
      ]);
      assertCommandSucceeded(platform, "launchctl bootout", result);
    } else if (platform === "linux") {
      const current = await status();
      if (!current.running) return;
      const result = await runCommand(runner, platform, "systemctl", [
        "--user",
        "stop",
        LINUX_SERVICE_NAME,
      ]);
      assertCommandSucceeded(platform, "systemctl --user stop", result);
    } else {
      const current = await status();
      if (!current.running) return;
      const result = await runCommand(
        runner,
        platform,
        "powershell.exe",
        powershellControl(
          `Stop-ScheduledTask -TaskName ${powerShellSingleQuoted(windowsTaskName)}`,
        ),
      );
      assertCommandSucceeded(platform, "Stop-ScheduledTask", result);
    }
  }

  async function restart(): Promise<void> {
    if (platform === "darwin") {
      if (!(await configExists(paths.serviceConfigPath))) {
        throw new PlatformCommandError("LaunchAgent is not installed");
      }
      const loaded = await runCommand(runner, platform, "launchctl", [
        "print",
        launchTarget,
      ]);
      if (loaded.exitCode === 0) {
        const result = await runCommand(runner, platform, "launchctl", [
          "kickstart",
          "-k",
          launchTarget,
        ]);
        assertCommandSucceeded(platform, "launchctl kickstart -k", result);
      } else {
        const result = await runCommand(runner, platform, "launchctl", [
          "bootstrap",
          `gui/${String(uid)}`,
          paths.serviceConfigPath,
        ]);
        assertCommandSucceeded(platform, "launchctl bootstrap", result);
      }
    } else if (platform === "linux") {
      const result = await runCommand(runner, platform, "systemctl", [
        "--user",
        "restart",
        LINUX_SERVICE_NAME,
      ]);
      assertCommandSucceeded(platform, "systemctl --user restart", result);
    } else {
      const stopResult = await runCommand(
        runner,
        platform,
        "powershell.exe",
        powershellControl(
          `Stop-ScheduledTask -TaskName ${powerShellSingleQuoted(windowsTaskName)}`,
        ),
      );
      assertCommandSucceeded(platform, "Stop-ScheduledTask", stopResult);
      const startResult = await runCommand(
        runner,
        platform,
        "powershell.exe",
        powershellControl(
          `Start-ScheduledTask -TaskName ${powerShellSingleQuoted(windowsTaskName)}`,
        ),
      );
      assertCommandSucceeded(platform, "Start-ScheduledTask", startResult);
    }
  }

  async function uninstall(): Promise<void> {
    if (platform === "darwin") {
      await stop();
      await removeConfig(paths.serviceConfigPath);
      return;
    }

    if (platform === "linux") {
      const current = await status();
      if (!current.installed) {
        await removeConfig(paths.serviceConfigPath);
        return;
      }
      const disable = await runCommand(runner, platform, "systemctl", [
        "--user",
        "disable",
        "--now",
        LINUX_SERVICE_NAME,
      ]);
      assertCommandSucceeded(platform, "systemctl --user disable", disable);
      await removeConfig(paths.serviceConfigPath);
      const reload = await runCommand(runner, platform, "systemctl", [
        "--user",
        "daemon-reload",
      ]);
      assertCommandSucceeded(
        platform,
        "systemctl --user daemon-reload",
        reload,
      );
      return;
    }

    const current = await status();
    if (!current.installed) {
      await removeConfig(paths.serviceConfigPath);
      return;
    }
    if (current.running) {
      const stopResult = await runCommand(
        runner,
        platform,
        "powershell.exe",
        powershellControl(
          `Stop-ScheduledTask -TaskName ${powerShellSingleQuoted(windowsTaskName)}`,
        ),
      );
      assertCommandSucceeded(platform, "Stop-ScheduledTask", stopResult);
    }
    const result = await runCommand(
      runner,
      platform,
      "powershell.exe",
      powershellControl(
        `Unregister-ScheduledTask -TaskName ${powerShellSingleQuoted(windowsTaskName)} -Confirm:$false`,
      ),
    );
    assertCommandSucceeded(platform, "Unregister-ScheduledTask", result);
    await removeConfig(paths.serviceConfigPath);
  }

  return { status, install, start, stop, restart, uninstall };
}

export function createServiceManager(
  dependencies: ServiceManagerDependencies,
): ServiceManager {
  return createManager(dependencies);
}

export type {
  CommandRunner,
  CommandRunnerLike,
  CommandResult,
} from "./command.js";
