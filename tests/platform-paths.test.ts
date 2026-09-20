import { describe, expect, it } from "vitest";

import {
  assertLinuxServiceRuntime,
  prepareOwnerDirectories,
  resolvePlatformPaths,
} from "../src/platform/paths.js";

describe("resolvePlatformPaths", () => {
  it("resolves the macOS owner-scoped state, log, run, and service paths", () => {
    const paths = resolvePlatformPaths({
      platform: "darwin",
      arch: "arm64",
      env: {},
      homeDir: "/Users/alice",
      username: "alice",
    });

    expect(paths.stateDir).toBe(
      "/Users/alice/Library/Application Support/send-message",
    );
    expect(paths.logDir).toBe("/Users/alice/Library/Logs/send-message");
    expect(paths.runDir).toBe(
      "/Users/alice/Library/Application Support/send-message/run",
    );
    expect(paths.socketPath).toBe(
      "/Users/alice/Library/Application Support/send-message/run/send-message.sock",
    );
    expect(paths.stateFile).toBe(
      "/Users/alice/Library/Application Support/send-message/state.json",
    );
    expect(paths.installationFile).toBe(
      "/Users/alice/Library/Application Support/send-message/installation.json",
    );
    expect(paths.idempotencyFile).toBe(
      "/Users/alice/Library/Application Support/send-message/idempotency.sqlite3",
    );
    expect(paths.clientCredentialFile).toBe(
      "/Users/alice/Library/Application Support/send-message/client-credential.json",
    );
    expect(paths.capabilityFile).toBe(
      "/Users/alice/Library/Application Support/send-message/capability",
    );
    expect(paths.tempDir).toBe(
      "/Users/alice/Library/Application Support/send-message/tmp",
    );
    expect(paths.serviceConfigPath).toBe(
      "/Users/alice/Library/LaunchAgents/io.github.waibiwaibig.send-message.plist",
    );
  });

  it("uses XDG state and runtime directories on Linux", () => {
    const paths = resolvePlatformPaths({
      platform: "linux",
      arch: "x64",
      env: {
        XDG_STATE_HOME: "/run/user/1000/state",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      libc: "glibc",
      homeDir: "/home/alice",
      username: "alice",
    });

    expect(paths.stateDir).toBe("/run/user/1000/state/send-message");
    expect(paths.logDir).toBe("/run/user/1000/state/send-message/logs");
    expect(paths.runDir).toBe("/run/user/1000/send-message");
    expect(paths.installationFile).toBe(
      "/run/user/1000/state/send-message/installation.json",
    );
    expect(paths.clientCredentialFile).toBe(
      "/run/user/1000/state/send-message/client-credential.json",
    );
    expect(paths.socketPath).toBe(
      "/run/user/1000/send-message/send-message.sock",
    );
    expect(paths.serviceConfigPath).toBe(
      "/home/alice/.config/systemd/user/send-message.service",
    );
  });

  it("resolves a persistent Linux client path without XDG_RUNTIME_DIR", () => {
    const paths = resolvePlatformPaths({
      platform: "linux",
      arch: "x64",
      env: {},
      libc: "glibc",
      homeDir: "/home/alice",
      username: "alice",
    });

    expect(paths.runDir).toBe("/home/alice/.local/state/send-message/run");
    expect(paths.clientCredentialFile).toBe(
      "/home/alice/.local/state/send-message/client-credential.json",
    );
    expect(paths.linuxRuntimeDir).toBeUndefined();
    expect(() => assertLinuxServiceRuntime(paths)).toThrowError(
      /UNSUPPORTED_PLATFORM/,
    );

    expect(() =>
      resolvePlatformPaths({
        platform: "linux",
        arch: "x64",
        env: { XDG_RUNTIME_DIR: "relative/run" },
        libc: "glibc",
        homeDir: "/home/alice",
        username: "alice",
      }),
    ).toThrowError(/UNSUPPORTED_PLATFORM/);

    expect(() =>
      resolvePlatformPaths({
        platform: "freebsd",
        arch: "x64",
        env: {},
        homeDir: "/home/alice",
        username: "alice",
      }),
    ).toThrowError(/UNSUPPORTED_PLATFORM/);

    expect(() =>
      resolvePlatformPaths({
        platform: "darwin",
        arch: "ia32",
        env: {},
        homeDir: "/Users/alice",
        username: "alice",
      }),
    ).toThrowError(/UNSUPPORTED_PLATFORM/);
  });

  it("uses a user-specific Windows named pipe derived from the username", () => {
    const paths = resolvePlatformPaths({
      platform: "win32",
      arch: "x64",
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      homeDir: "C:\\Users\\Alice",
      username: "Alice/tenant",
    });

    expect(paths.stateDir).toBe(
      "C:\\Users\\Alice\\AppData\\Local\\send-message",
    );
    expect(paths.logDir).toBe(paths.stateDir + "\\log");
    expect(paths.runDir).toBe(paths.stateDir + "\\run");
    expect(paths.socketPath).toMatch(
      /^\\\\\.\\pipe\\send-message-[0-9a-f]{16}$/,
    );
    expect(paths.installationFile).toBe(paths.stateDir + "\\installation.json");
    expect(paths.clientCredentialFile).toBe(
      paths.stateDir + "\\client-credential.json",
    );
    expect(paths.serviceConfigPath).toBe(paths.stateDir + "\\service.ps1");
  });
});

describe("prepareOwnerDirectories", () => {
  it("creates owner-only POSIX directories and rejects existing broad permissions", async () => {
    const paths = resolvePlatformPaths({
      platform: "darwin",
      arch: "arm64",
      env: {},
      homeDir: "/Users/alice",
      username: "alice",
    });
    const calls: Array<{ path: string; mode: number }> = [];

    await prepareOwnerDirectories(paths, {
      platform: "darwin",
      filesystem: {
        mkdir: async (path, mode) => {
          calls.push({ path, mode });
        },
        statMode: async () => 0o700,
      },
    });

    expect(calls.every((call) => call.mode === 0o700)).toBe(true);
    expect(calls.map((call) => call.path)).toEqual(
      expect.arrayContaining([
        paths.stateDir,
        paths.logDir,
        paths.runDir,
        paths.tempDir,
      ]),
    );

    await expect(
      prepareOwnerDirectories(paths, {
        platform: "darwin",
        filesystem: {
          mkdir: async () => undefined,
          statMode: async () => 0o750,
        },
      }),
    ).rejects.toThrowError(/owner-only/);
  });

  it("uses icacls without shell on Windows and propagates failures", async () => {
    const paths = resolvePlatformPaths({
      platform: "win32",
      arch: "x64",
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      homeDir: "C:\\Users\\Alice",
      username: "Alice",
    });
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];

    await prepareOwnerDirectories(paths, {
      platform: "win32",
      runCommand: {
        run: async (file, args, options) => {
          calls.push({
            file,
            args,
            ...(options?.shell === undefined ? {} : { shell: options.shell }),
          });
          return {
            exitCode: 0,
            stdout: file === "powershell.exe" ? "S-1-5-21-1000\n" : "",
            stderr: "",
          };
        },
      },
      filesystem: {
        mkdir: async () => undefined,
        statMode: async () => 0,
      },
    });

    expect(calls[0]?.file).toBe("powershell.exe");
    expect(calls.slice(1).every((call) => call.file === "icacls")).toBe(true);
    expect(calls.every((call) => call.shell === false)).toBe(true);
    expect(
      calls.slice(1).every((call) => call.args.includes("/inheritance:r")),
    ).toBe(true);
    expect(
      calls
        .slice(1)
        .every((call) =>
          call.args.some((arg) => arg.includes("*S-1-5-21-1000")),
        ),
    ).toBe(true);
  });

  it("runs POSIX permission hardening callbacks and rejects platform mismatches", async () => {
    const paths = resolvePlatformPaths({
      platform: "darwin",
      arch: "arm64",
      env: {},
      homeDir: "/Users/a",
      username: "a",
    });
    const calls: string[] = [];
    await prepareOwnerDirectories(paths, {
      platform: "darwin",
      filesystem: {
        mkdir: async (directory) => {
          calls.push(`mkdir:${directory}`);
        },
        chmod: async (directory) => {
          calls.push(`chmod:${directory}`);
        },
        statMode: async () => 0o700,
        assertSafeDirectory: async (directory) => {
          calls.push(`assert:${directory}`);
        },
      },
    });
    expect(calls.filter((call) => call.startsWith("chmod:")).length).toBe(4);
    expect(calls.filter((call) => call.startsWith("assert:")).length).toBe(4);
    await expect(
      prepareOwnerDirectories(paths, {
        platform: "linux",
        filesystem: { mkdir: async () => {}, statMode: async () => 0o700 },
      }),
    ).rejects.toThrow(/platform/);
  });

  it("fails closed when Windows identity or ACL commands fail", async () => {
    const paths = resolvePlatformPaths({
      platform: "win32",
      arch: "x64",
      env: { LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local" },
      homeDir: "C:\\Users\\A",
      username: "A",
    });
    await expect(
      prepareOwnerDirectories(paths, {
        platform: "win32",
        filesystem: { mkdir: async () => {}, statMode: async () => 0 },
        runCommand: {
          run: async () => ({ exitCode: 1, stdout: "", stderr: "no SID" }),
        },
      }),
    ).rejects.toThrow(/SID/);
    await expect(
      prepareOwnerDirectories(paths, {
        platform: "win32",
        filesystem: { mkdir: async () => {}, statMode: async () => 0 },
        runCommand: {
          run: async (file) =>
            file === "powershell.exe"
              ? { exitCode: 0, stdout: "S-1-5-21-1000\n", stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "ACL failed" },
        },
      }),
    ).rejects.toThrow(/icacls failed/);
  });
});
