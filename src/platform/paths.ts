import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, stat } from "node:fs/promises";
import * as path from "node:path";

import {
  defaultCommandRunner,
  runWithCommandRunner,
  type CommandRunnerLike,
} from "./command.js";

export type SupportedPlatform = "darwin" | "linux" | "win32";
export type SupportedArch = "x64" | "arm64";

export type PlatformPaths = {
  readonly platform: SupportedPlatform;
  readonly arch: SupportedArch;
  readonly username: string;
  readonly stateDir: string;
  readonly logDir: string;
  readonly runDir: string;
  readonly socketPath: string;
  readonly ipcEndpoint: string;
  readonly stateFile: string;
  readonly installationFile: string;
  readonly idempotencyFile: string;
  readonly capabilityFile: string;
  readonly tempDir: string;
  readonly serviceConfigPath: string;
};

export type ResolvePlatformPathsInput = {
  readonly platform: string;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly username: string;
  readonly libc?: string;
};

export type PlatformFilesystem = {
  mkdir(path: string, mode: number): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  statMode(path: string): Promise<number>;
  assertSafeDirectory?(path: string): Promise<void>;
};

export type PrepareOwnerDirectoriesOptions = {
  readonly platform: SupportedPlatform;
  readonly filesystem?: PlatformFilesystem;
  readonly runCommand?: CommandRunnerLike;
};

export class UnsupportedPlatformError extends Error {
  public readonly code = "UNSUPPORTED_PLATFORM";

  public constructor(message: string) {
    super(`UNSUPPORTED_PLATFORM: ${message}`);
    this.name = "UnsupportedPlatformError";
  }
}

export class PlatformCommandError extends Error {
  public readonly code = "PLATFORM_COMMAND_FAILED";

  public constructor(message: string) {
    super(`PLATFORM_COMMAND_FAILED: ${message}`);
    this.name = "PlatformCommandError";
  }
}

function unsupported(message: string): never {
  throw new UnsupportedPlatformError(message);
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) unsupported(`${name} is required`);
}

function assertLinuxGlibc(
  platform: SupportedPlatform,
  declaredLibc: string | undefined,
): void {
  if (platform !== "linux") return;

  if (declaredLibc !== undefined && declaredLibc.toLowerCase() !== "glibc") {
    unsupported(`Linux libc must be glibc, got ${declaredLibc}`);
  }

  // A resolver may be used to inspect a foreign platform in tests or while
  // preparing a deployment. Only reject a detected musl host; an unknown
  // foreign host is intentionally left to the runtime support probe.
  if (declaredLibc === undefined && process.platform === "linux") {
    const report = process.report?.getReport() as
      { header?: { glibcVersionRuntime?: string } } | undefined;
    const glibcVersion = report?.header?.glibcVersionRuntime;
    if (glibcVersion === undefined)
      unsupported("Linux musl/non-glibc is not supported");
  }
}

function resolvePosixPaths(
  platform: "darwin" | "linux",
  arch: SupportedArch,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  username: string,
  libc: string | undefined,
): PlatformPaths {
  const join = (...parts: string[]): string => path.posix.join(...parts);
  let stateDir: string;
  let logDir: string;
  let runDir: string;
  let serviceConfigPath: string;

  if (platform === "darwin") {
    if (!path.posix.isAbsolute(homeDir))
      unsupported("homeDir must be absolute");
    stateDir = join(homeDir, "Library", "Application Support", "send-wechat");
    logDir = join(homeDir, "Library", "Logs", "send-wechat");
    runDir = join(stateDir, "run");
    serviceConfigPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "io.github.waibiwaibig.send-wechat.plist",
    );
  } else {
    assertLinuxGlibc(platform, libc);
    const stateHome =
      env.XDG_STATE_HOME === undefined || env.XDG_STATE_HOME.length === 0
        ? join(homeDir, ".local", "state")
        : env.XDG_STATE_HOME;
    const runtimeDir = env.XDG_RUNTIME_DIR;
    if (runtimeDir === undefined || runtimeDir.length === 0) {
      unsupported("XDG_RUNTIME_DIR is required on Linux");
    }
    if (
      !path.posix.isAbsolute(homeDir) ||
      !path.posix.isAbsolute(stateHome) ||
      !path.posix.isAbsolute(runtimeDir)
    ) {
      unsupported("Linux home and XDG directories must be absolute");
    }
    stateDir = join(stateHome, "send-wechat");
    logDir = join(stateDir, "logs");
    runDir = join(runtimeDir, "send-wechat");
    serviceConfigPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "send-wechat.service",
    );
  }

  const socketPath = join(runDir, "send-wechat.sock");
  return {
    platform,
    arch,
    username,
    stateDir,
    logDir,
    runDir,
    socketPath,
    ipcEndpoint: socketPath,
    stateFile: join(stateDir, "state.json"),
    installationFile: join(stateDir, "installation.json"),
    idempotencyFile: join(stateDir, "idempotency.sqlite3"),
    capabilityFile: join(stateDir, "capability"),
    tempDir: join(stateDir, "tmp"),
    serviceConfigPath,
  };
}

export function resolvePlatformPaths(
  input: ResolvePlatformPathsInput,
): PlatformPaths {
  if (
    input.platform !== "darwin" &&
    input.platform !== "linux" &&
    input.platform !== "win32"
  ) {
    unsupported(`platform ${input.platform} is not supported`);
  }
  if (input.arch !== "x64" && input.arch !== "arm64") {
    unsupported(`architecture ${input.arch} is not supported`);
  }
  assertNonEmpty(input.homeDir, "homeDir");
  assertNonEmpty(input.username, "username");

  if (input.platform !== "win32") {
    return resolvePosixPaths(
      input.platform,
      input.arch,
      input.env,
      input.homeDir,
      input.username,
      input.libc,
    );
  }

  const localAppData = input.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    unsupported("LOCALAPPDATA is required on Windows");
  }
  if (!path.win32.isAbsolute(localAppData)) {
    unsupported("LOCALAPPDATA must be absolute on Windows");
  }
  const join = (...parts: string[]): string => path.win32.join(...parts);
  const stateDir = join(localAppData, "send-wechat");
  const runDir = join(stateDir, "run");
  const socketPath = `\\\\.\\pipe\\send-wechat-${createHash("sha256")
    .update(
      `${input.username.toLowerCase()}\0${path.win32.resolve(localAppData).toLowerCase()}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 16)}`;
  return {
    platform: "win32",
    arch: input.arch,
    username: input.username,
    stateDir,
    logDir: join(stateDir, "log"),
    runDir,
    socketPath,
    ipcEndpoint: socketPath,
    stateFile: join(stateDir, "state.json"),
    installationFile: join(stateDir, "installation.json"),
    idempotencyFile: join(stateDir, "idempotency.sqlite3"),
    capabilityFile: join(stateDir, "capability"),
    tempDir: join(stateDir, "tmp"),
    serviceConfigPath: join(stateDir, "service.ps1"),
  };
}

const realFilesystem: PlatformFilesystem = {
  async mkdir(directory, mode) {
    await mkdir(directory, { recursive: true, mode });
  },
  async chmod(directory, mode) {
    await chmod(directory, mode);
  },
  async statMode(directory) {
    return (await stat(directory)).mode;
  },
  async assertSafeDirectory(directory) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PlatformCommandError(
        `directory ${directory} is not a real directory`,
      );
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new PlatformCommandError(
        `directory ${directory} is not owned by the current user`,
      );
    }
  },
};

function directoriesFor(paths: PlatformPaths): string[] {
  return [
    ...new Set([paths.stateDir, paths.logDir, paths.runDir, paths.tempDir]),
  ];
}

export async function prepareOwnerDirectories(
  paths: PlatformPaths,
  options: PrepareOwnerDirectoriesOptions,
): Promise<void> {
  if (options.platform !== paths.platform) {
    unsupported(
      `directory platform ${options.platform} does not match ${paths.platform}`,
    );
  }
  const filesystem = options.filesystem ?? realFilesystem;
  const directories = directoriesFor(paths);

  for (const directory of directories) {
    await filesystem.mkdir(directory, 0o700);
    await filesystem.assertSafeDirectory?.(directory);
    if (options.platform !== "win32") {
      await filesystem.chmod?.(directory, 0o700);
      const mode = await filesystem.statMode(directory);
      if ((mode & 0o077) !== 0) {
        throw new PlatformCommandError(
          `directory ${directory} is not owner-only (mode ${mode.toString(8)})`,
        );
      }
    }
  }

  if (options.platform === "win32") {
    const runner = options.runCommand ?? defaultCommandRunner;
    const identity = await runWithCommandRunner(
      runner,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { shell: false },
    );
    const sid = identity.stdout.trim();
    if (identity.exitCode !== 0 || !/^S-1-(?:\d+-)+\d+$/.test(sid)) {
      throw new PlatformCommandError(
        "could not resolve the current Windows SID",
      );
    }
    for (const directory of directories) {
      const result = await runWithCommandRunner(
        runner,
        "icacls",
        [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
        { shell: false },
      );
      if (result.exitCode !== 0) {
        throw new PlatformCommandError(
          `icacls failed for ${directory}: ${result.stderr || `exit ${result.exitCode}`}`,
        );
      }
    }
  }
}

export type { CommandRunnerLike } from "./command.js";
