import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createServiceManager,
  type ServiceManagerDependencies,
} from "../src/platform/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

function runnerFor(
  calls: Array<{ file: string; args: readonly string[]; shell?: boolean }>,
) {
  return {
    run: async (
      file: string,
      args: readonly string[],
      options?: { shell?: false },
    ) => {
      calls.push({
        file,
        args,
        ...(options?.shell === undefined ? {} : { shell: options.shell }),
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function result(
  exitCode: number,
  stderr = "",
  stdout = "",
): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode, stdout, stderr };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "send-message-platform-"));
  temporaryDirectories.push(root);
  return root;
}

function dependencies(
  platform: "darwin" | "linux" | "win32",
  serviceConfigPath: string,
  calls: Array<{ file: string; args: readonly string[]; shell?: boolean }>,
  overrides: Partial<ServiceManagerDependencies> = {},
): ServiceManagerDependencies {
  const stateDir = path.dirname(serviceConfigPath);
  return {
    platform,
    paths: {
      platform,
      arch: "x64",
      username: "alice",
      stateDir,
      logDir: path.join(stateDir, "logs"),
      runDir: path.join(stateDir, "run"),
      socketPath: path.join(stateDir, "run", "send-message.sock"),
      ipcEndpoint: path.join(stateDir, "run", "send-message.sock"),
      stateFile: path.join(stateDir, "state.json"),
      installationFile: path.join(stateDir, "installation.json"),
      idempotencyFile: path.join(stateDir, "idempotency.sqlite3"),
      capabilityFile: path.join(stateDir, "capability"),
      clientCredentialFile: path.join(stateDir, "client-credential.json"),
      tempDir: path.join(stateDir, "tmp"),
      serviceConfigPath,
    },
    nodeExecutable:
      platform === "win32"
        ? "C:\\Program Files\\node\\node.exe"
        : "/opt/node/bin/node",
    cliEntry:
      platform === "win32"
        ? "C:\\Program Files\\send-message\\cli.js"
        : "/opt/send-message/cli.js",
    uid: "501",
    username: "alice",
    commandRunner: runnerFor(calls),
    ...overrides,
  };
}

describe("service daemon arguments", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "passes each daemon argument to the %s service definition",
    async (platform) => {
      const root = await fixtureRoot();
      const config = path.join(root, `gateway-${platform}.service`);
      const calls: Array<{
        file: string;
        args: readonly string[];
        shell?: boolean;
      }> = [];
      const manager = createServiceManager(
        dependencies(platform, config, calls, {
          daemonArgs: ["--channel", "feishu", "internal-daemon"],
        }),
      );

      await manager.install();
      const definition = await readFile(config, "utf8");
      expect(definition).toContain("--channel");
      expect(definition).toContain("feishu");
      expect(definition).toContain("internal-daemon");
    },
  );
});

describe("macOS service manager", () => {
  it("writes the exact LaunchAgent definition and keeps install separate from start", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "io.github.waibiwaibig.send-message.plist");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(dependencies("darwin", config, calls));

    await manager.install();
    const definition = await readFile(config, "utf8");
    expect(definition).toContain("<key>Label</key>");
    expect(definition).toContain("io.github.waibiwaibig.send-message");
    expect(definition).toContain("<string>/opt/node/bin/node</string>");
    expect(definition).toContain("<string>/opt/send-message/cli.js</string>");
    expect(definition).toContain("<string>internal-daemon</string>");
    expect(definition).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(definition).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(definition).toContain(
      "<key>ThrottleInterval</key>\n\t<integer>5</integer>",
    );
    expect(calls).toEqual([]);

    await manager.start();
    await manager.stop();
    await manager.restart();
    expect(calls).toEqual([
      {
        file: "launchctl",
        args: ["print", "gui/501/io.github.waibiwaibig.send-message"],
        shell: false,
      },
      {
        file: "launchctl",
        args: ["kickstart", "gui/501/io.github.waibiwaibig.send-message"],
        shell: false,
      },
      {
        file: "launchctl",
        args: ["print", "gui/501/io.github.waibiwaibig.send-message"],
        shell: false,
      },
      {
        file: "launchctl",
        args: ["bootout", "gui/501/io.github.waibiwaibig.send-message"],
        shell: false,
      },
      {
        file: "launchctl",
        args: ["print", "gui/501/io.github.waibiwaibig.send-message"],
        shell: false,
      },
      {
        file: "launchctl",
        args: ["kickstart", "-k", "gui/501/io.github.waibiwaibig.send-message"],
        shell: false,
      },
    ]);
  });

  it("reports absence and bootstraps an installed but unloaded agent", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "send-message.plist");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("darwin", config, calls, {
        commandRunner: {
          run: async (
            file: string,
            args: readonly string[],
            options?: { shell?: false },
          ) => {
            calls.push({
              file,
              args,
              ...(options?.shell === undefined ? {} : { shell: options.shell }),
            });
            return args[0] === "print" ? result(113, "not loaded") : result(0);
          },
        },
      }),
    );

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      running: false,
    });
    await expect(manager.start()).rejects.toThrowError(/not installed/);
    await expect(manager.restart()).rejects.toThrowError(/not installed/);

    await manager.install();
    await expect(manager.status()).resolves.toEqual({
      installed: true,
      running: false,
    });
    await manager.start();
    await manager.restart();
    await manager.stop();
    await manager.uninstall();
    await expect(manager.status()).resolves.toEqual({
      installed: false,
      running: false,
    });

    expect(calls.filter((call) => call.args[0] === "bootstrap")).toHaveLength(
      2,
    );
    expect(calls.some((call) => call.args[0] === "bootout")).toBe(false);
  });

  it("surfaces launchctl failures as platform command errors", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "send-message.plist");
    const manager = createServiceManager(
      dependencies("darwin", config, [], {
        commandRunner: {
          run: async (_file, args) =>
            args[0] === "print"
              ? result(113, "not loaded")
              : result(5, "bootstrap denied"),
        },
      }),
    );
    await manager.install();
    await expect(manager.start()).rejects.toThrowError(
      /launchctl bootstrap failed: bootstrap denied/,
    );
  });

  it("uses a custom label for the complete LaunchAgent lifecycle", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "gateway.plist");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("darwin", config, calls, {
        identity: {
          label: "io.example.gateway<&",
          linuxServiceName: "send-message-gateway.service",
          windowsTaskPrefix: "send-message-gateway",
          description: "send-message Codex gateway",
        },
      }),
    );

    await manager.install();
    const definition = await readFile(config, "utf8");
    expect(definition).toContain(
      "<string>io.example.gateway&lt;&amp;</string>",
    );
    expect(definition).not.toContain(
      "<string>io.github.waibiwaibig.send-message</string>",
    );

    await manager.status();
    await manager.start();
    await manager.stop();
    await manager.uninstall();

    const targets = calls
      .filter((call) => call.file === "launchctl")
      .flatMap((call) => call.args)
      .filter((argument) => argument.includes("gui/501/"));
    expect(targets.length).toBeGreaterThan(0);
    expect(
      targets.every((target) => target === "gui/501/io.example.gateway<&"),
    ).toBe(true);
    expect(targets.some((target) => target.includes("send-message"))).toBe(
      false,
    );
  });
});

describe("Linux service manager", () => {
  it("writes an escaped user unit, reloads, and enables without starting", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "send-message.service");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("linux", config, calls, {
        nodeExecutable: "/opt/node with space/bin/node",
        cliEntry: '/opt/send-message/cli"entry.js',
      }),
    );

    await manager.install();
    const definition = await readFile(config, "utf8");
    expect(definition).toContain(
      'ExecStart="/opt/node with space/bin/node" "/opt/send-message/cli\\\"entry.js" "internal-daemon"',
    );
    expect(definition).toContain("Restart=on-failure");
    expect(calls).toEqual([
      { file: "systemctl", args: ["--user", "daemon-reload"], shell: false },
      {
        file: "systemctl",
        args: ["--user", "enable", "send-message.service"],
        shell: false,
      },
    ]);
  });

  it("reports an unavailable systemd user manager explicitly", async () => {
    const root = await fixtureRoot();
    const manager = createServiceManager(
      dependencies("linux", path.join(root, "send-message.service"), [], {
        commandRunner: {
          run: async () => {
            const error = new Error("systemctl not found") as Error & {
              code: string;
            };
            error.code = "ENOENT";
            throw error;
          },
        },
      }),
    );

    await expect(manager.status()).rejects.toThrowError(/UNSUPPORTED_PLATFORM/);
  });

  it("distinguishes an absent unit from an unavailable systemd manager", async () => {
    const root = await fixtureRoot();
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("linux", path.join(root, "send-message.service"), calls, {
        commandRunner: {
          run: async (file, args, options) => {
            calls.push({
              file,
              args,
              ...(options?.shell === undefined ? {} : { shell: options.shell }),
            });
            return result(1, "Failed to get unit file state: No such file");
          },
        },
      }),
    );

    await expect(manager.status()).resolves.toEqual({
      installed: false,
      running: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("controls an installed systemd user service through its full lifecycle", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "send-message.service");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("linux", config, calls, {
        commandRunner: {
          run: async (file, args, options) => {
            calls.push({
              file,
              args,
              ...(options?.shell === undefined ? {} : { shell: options.shell }),
            });
            return result(0);
          },
        },
      }),
    );

    await manager.install();
    await expect(manager.status()).resolves.toEqual({
      installed: true,
      running: true,
    });
    await manager.start();
    await manager.restart();
    await manager.stop();
    await manager.uninstall();

    const invocations = calls.map((call) => call.args.join(" "));
    expect(invocations).toContain("--user start send-message.service");
    expect(invocations).toContain("--user restart send-message.service");
    expect(invocations).toContain("--user stop send-message.service");
    expect(invocations).toContain("--user disable --now send-message.service");
    await expect(readFile(config, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not stop an inactive unit and reports command failures", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "send-message.service");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("linux", config, calls, {
        commandRunner: {
          run: async (file, args, options) => {
            calls.push({
              file,
              args,
              ...(options?.shell === undefined ? {} : { shell: options.shell }),
            });
            if (args.includes("is-active")) return result(3, "inactive");
            if (args.includes("start")) return result(1, "unit failed");
            return result(0);
          },
        },
      }),
    );
    await manager.install();
    await manager.stop();
    expect(calls.some((call) => call.args.includes("stop"))).toBe(false);
    await expect(manager.start()).rejects.toThrowError(
      /systemctl --user start failed: unit failed/,
    );
  });

  it("maps a disconnected user bus result to unsupported platform", async () => {
    const root = await fixtureRoot();
    const manager = createServiceManager(
      dependencies("linux", path.join(root, "send-message.service"), [], {
        commandRunner: {
          run: async () => result(1, "Failed to connect to bus"),
        },
      }),
    );
    await expect(manager.status()).rejects.toThrowError(/UNSUPPORTED_PLATFORM/);
  });

  it("uses a custom service name and description for the complete lifecycle", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "gateway.service");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("linux", config, calls, {
        identity: {
          label: "io.example.gateway",
          linuxServiceName: "send-message-gateway.service",
          windowsTaskPrefix: "send-message-gateway",
          description: 'send-message "Codex" & gateway %',
        },
      }),
    );

    await manager.install();
    const definition = await readFile(config, "utf8");
    expect(definition).toContain(
      'Description="send-message \\\"Codex\\\" & gateway %%"',
    );
    expect(definition).not.toContain("Description=send-message daemon");

    await manager.status();
    await manager.start();
    await manager.stop();
    await manager.uninstall();

    const serviceArguments = calls
      .flatMap((call) => call.args)
      .filter((argument) => argument.endsWith(".service"));
    expect(serviceArguments.length).toBeGreaterThan(0);
    expect(
      serviceArguments.every(
        (argument) => argument === "send-message-gateway.service",
      ),
    ).toBe(true);
    expect(serviceArguments).not.toContain("send-message.service");
  });
});

describe("Windows service manager", () => {
  it("writes an owner-scoped registration script and uses non-shell PowerShell control", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "service.ps1");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("win32", config, calls, {
        username: "alice'o;$(Get-ChildItem)",
      }),
    );

    await manager.install();
    const definition = await readFile(config, "utf8");
    expect(definition).toContain("New-ScheduledTaskAction");
    expect(definition).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(definition).toContain("-LogonType Interactive");
    expect(definition).toContain("-RunLevel Limited");
    expect(definition).toContain(
      "$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    );
    expect(definition).toContain("-User $currentUser");
    expect(definition).not.toContain("alice'o;$(Get-ChildItem)");
    expect(calls).toEqual([
      {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          config,
        ],
        shell: false,
      },
    ]);

    await manager.start();
    await manager.stop();
    await manager.uninstall();
    expect(calls.slice(1).every((call) => call.file === "powershell.exe")).toBe(
      true,
    );
    expect(
      calls
        .slice(1)
        .every(
          (call) =>
            call.args.slice(0, 4).join(" ") ===
            "-NoProfile -NonInteractive -ExecutionPolicy Bypass",
        ),
    ).toBe(true);
    expect(
      calls
        .slice(1)
        .some((call) => call.args.at(-1)?.includes("Start-ScheduledTask")),
    ).toBe(true);
    expect(
      calls
        .slice(1)
        .some((call) => call.args.at(-1)?.includes("Stop-ScheduledTask")),
    ).toBe(true);
    expect(
      calls
        .slice(1)
        .some((call) => call.args.at(-1)?.includes("Unregister-ScheduledTask")),
    ).toBe(true);
  });

  it("distinguishes absent, stopped, running, and failed task status", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "service.ps1");

    for (const [exitCode, expected] of [
      [3, { installed: false, running: false }],
      [1, { installed: true, running: false }],
      [0, { installed: true, running: true }],
    ] as const) {
      const manager = createServiceManager(
        dependencies("win32", config, [], {
          commandRunner: { run: async () => result(exitCode) },
        }),
      );
      await expect(manager.status()).resolves.toEqual(expected);
    }

    const failed = createServiceManager(
      dependencies("win32", config, [], {
        commandRunner: {
          run: async () => result(5, "Access denied"),
        },
      }),
    );
    await expect(failed.status()).rejects.toThrowError(
      /Scheduled Task status failed: Access denied/,
    );
  });

  it("skips inactive stops and unregisters an installed stopped task", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "service.ps1");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("win32", config, calls, {
        commandRunner: {
          run: async (file, args, options) => {
            calls.push({
              file,
              args,
              ...(options?.shell === undefined ? {} : { shell: options.shell }),
            });
            const command = args.at(-1) ?? "";
            if (command.includes("Get-ScheduledTask")) return result(1);
            return result(0);
          },
        },
      }),
    );

    await manager.install();
    calls.length = 0;
    await manager.stop();
    expect(calls).toHaveLength(1);
    await manager.restart();
    expect(
      calls.some((call) => call.args.at(-1)?.includes("Stop-ScheduledTask")),
    ).toBe(true);
    expect(
      calls.some((call) => call.args.at(-1)?.includes("Start-ScheduledTask")),
    ).toBe(true);
    calls.length = 0;
    await manager.uninstall();
    expect(
      calls.some((call) =>
        call.args.at(-1)?.includes("Unregister-ScheduledTask"),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.args.at(-1)?.startsWith("Stop-ScheduledTask")),
    ).toBe(false);
  });

  it("uses a custom identity for the complete Windows lifecycle", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "gateway-service.ps1");
    const calls: Array<{
      file: string;
      args: readonly string[];
      shell?: boolean;
    }> = [];
    const manager = createServiceManager(
      dependencies("win32", config, calls, {
        identity: {
          label: "io.example.gateway<&",
          linuxServiceName: "send-message-gateway.service",
          windowsTaskPrefix: "gateway'$(Invoke-Thing)",
          description: 'send-message "Codex" & gateway %',
        },
      }),
    );

    await manager.install();
    const definition = await readFile(config, "utf8");
    expect(definition).toContain(
      "Register-ScheduledTask -TaskName 'gateway''$(Invoke-Thing)-",
    );
    expect(definition).not.toMatch(/-TaskName 'send-message-[0-9a-f]{16}'/);

    await manager.status();
    await manager.start();
    await manager.stop();
    await manager.uninstall();

    const commands = calls
      .map((call) => call.args.at(-1) ?? "")
      .filter((command) => command.includes("-TaskName"));
    expect(commands.length).toBeGreaterThan(0);
    expect(
      commands.every((command) =>
        command.includes("gateway''$(Invoke-Thing)-"),
      ),
    ).toBe(true);
    expect(commands.some((command) => command.includes("send-message-"))).toBe(
      false,
    );
  });

  it("rejects a service manager whose platform and paths disagree", async () => {
    const root = await fixtureRoot();
    const deps = dependencies("darwin", path.join(root, "service.plist"), []);
    expect(() =>
      createServiceManager({
        ...deps,
        platform: "linux",
      }),
    ).toThrowError(/does not match/);
  });

  it("rejects identity controls and unsafe service names", async () => {
    const root = await fixtureRoot();
    const config = path.join(root, "service.plist");

    expect(() =>
      createServiceManager(
        dependencies("darwin", config, [], {
          identity: {
            label: "gateway\nlabel",
            linuxServiceName: "gateway.service",
            windowsTaskPrefix: "gateway",
            description: "gateway",
          },
        }),
      ),
    ).toThrowError(/control characters/);

    expect(() =>
      createServiceManager(
        dependencies("linux", config, [], {
          identity: {
            label: "gateway",
            linuxServiceName: "..\/gateway.service",
            windowsTaskPrefix: "gateway",
            description: "gateway",
          },
        }),
      ),
    ).toThrowError(/linuxServiceName/);

    expect(() =>
      createServiceManager(
        dependencies("win32", config, [], {
          identity: {
            label: "gateway",
            linuxServiceName: "gateway.service",
            windowsTaskPrefix: "gateway\\child",
            description: "gateway",
          },
        }),
      ),
    ).toThrowError(/windowsTaskPrefix/);
  });
});
