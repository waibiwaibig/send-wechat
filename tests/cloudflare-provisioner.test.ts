import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CloudflareProvisioner,
  CloudflareProvisioningError,
  type CloudflareCommandRunner,
  type CloudflareProvisioningProgress,
} from "../src/relay/cloudflare.js";

const directories: string[] = [];
const hubAuthToken = Buffer.alloc(32, 7).toString("base64url");

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("user-owned Cloudflare relay provisioning", () => {
  it("authenticates once, deploys with an ephemeral secret file, verifies health, and cleans up", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-cloudflare-"));
    directories.push(root);
    const calls: Array<{
      args: readonly string[];
      mode: "capture" | "inherit" | "tee";
    }> = [];
    let whoamiCalls = 0;
    const runner: CloudflareCommandRunner = {
      run: async (_file, args, options) => {
        calls.push({ args, mode: options.mode });
        if (args.includes("auth"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("whoami")) {
          whoamiCalls += 1;
          return whoamiCalls === 1
            ? { exitCode: 1, stdout: "", stderr: "not authenticated" }
            : {
                exitCode: 0,
                stdout: JSON.stringify({
                  loggedIn: true,
                  authType: "OAuth Token",
                  accounts: [{ id: "account-1", name: "Alice" }],
                }),
                stderr: "",
              };
        }
        if (args.includes("login"))
          return { exitCode: 0, stdout: "", stderr: "" };
        expect(options.mode).toBe("inherit");
        const outputFilePath = (
          options as typeof options & { env?: NodeJS.ProcessEnv }
        ).env?.WRANGLER_OUTPUT_FILE_PATH;
        expect(outputFilePath).toEqual(expect.any(String));
        const configPath = args[args.indexOf("--config") + 1]!;
        const secretPath = args[args.indexOf("--secrets-file") + 1]!;
        const config = JSON.parse(await readFile(configPath, "utf8")) as {
          account_id: string;
          main: string;
          exports: unknown;
        };
        expect(config.account_id).toBe("account-1");
        expect(config.main).toBe("/package/dist/relay/worker.js");
        expect(config.exports).toBeDefined();
        expect(await readFile(secretPath, "utf8")).toBe(
          JSON.stringify({ HUB_AUTH_TOKEN: hubAuthToken }),
        );
        if (process.platform !== "win32") {
          expect((await stat(configPath)).mode & 0o777).toBe(0o600);
          expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
        }
        await writeFile(
          outputFilePath!,
          `${JSON.stringify({
            type: "deploy",
            version: 1,
            worker_name: "send-wechat-a1b2c3d4",
            targets: ["https://send-wechat-a1b2c3d4.alice.workers.dev"],
          })}\n`,
          "utf8",
        );
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    };
    const probed: string[] = [];
    const progress: CloudflareProvisioningProgress[] = [];
    const provisioner = new CloudflareProvisioner({
      temporaryRoot: root,
      relayEntrypoint: "/package/dist/relay/worker.js",
      wranglerBin: "/package/node_modules/wrangler/bin/wrangler.js",
      nodeExecutable: "/node",
      runner,
      probe: async (url, onProgress) => {
        probed.push(url);
        await onProgress({
          stage: "health_check",
          attempt: 1,
          maxAttempts: 15,
        });
      },
      onProgress: async (event) => {
        progress.push(event);
      },
    });

    await expect(
      provisioner.provision({
        workerName: "send-wechat-a1b2c3d4",
        hubAuthToken,
      }),
    ).resolves.toEqual({
      accountId: "account-1",
      relayUrl: "https://send-wechat-a1b2c3d4.alice.workers.dev",
      workerName: "send-wechat-a1b2c3d4",
    });
    expect(calls.map(({ args }) => args[1])).toEqual([
      "auth",
      "whoami",
      "login",
      "whoami",
      "deploy",
    ]);
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining(["login", "--device", "--use-keyring"]),
    );
    expect(calls[2]?.mode).toBe("inherit");
    expect(probed).toEqual([
      "https://send-wechat-a1b2c3d4.alice.workers.dev/v1/health",
    ]);
    expect(progress).toEqual([
      { stage: "health_check", attempt: 1, maxAttempts: 15 },
    ]);
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed on ambiguous accounts or an untrusted deployment URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-cloudflare-"));
    directories.push(root);
    const accounts = JSON.stringify({
      loggedIn: true,
      authType: "OAuth Token",
      accounts: [
        { id: "account-1", name: "Alice" },
        { id: "account-2", name: "Team" },
      ],
    });
    const runner: CloudflareCommandRunner = {
      run: async (_file, args, options) => {
        if (args.includes("auth"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("whoami"))
          return { exitCode: 0, stdout: accounts, stderr: "" };
        if (args.includes("delete"))
          return { exitCode: 0, stdout: "", stderr: "" };
        await writeFile(
          options.env!.WRANGLER_OUTPUT_FILE_PATH!,
          `${JSON.stringify({
            type: "deploy",
            version: 1,
            worker_name: "send-wechat-a1b2c3d4",
            targets: ["https://attacker.example.com"],
          })}\n`,
          "utf8",
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const base = {
      temporaryRoot: root,
      relayEntrypoint: "/package/dist/relay/worker.js",
      wranglerBin: "/wrangler.js",
      nodeExecutable: "/node",
      runner,
      probe: async () => undefined,
    };
    await expect(
      new CloudflareProvisioner(base).provision({
        workerName: "send-wechat-a1b2c3d4",
        hubAuthToken,
      }),
    ).rejects.toMatchObject({
      code: "CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED",
    });
    await expect(
      new CloudflareProvisioner({
        ...base,
        selectAccount: async (items) => items[1]!.id,
      }).provision({
        workerName: "send-wechat-a1b2c3d4",
        hubAuthToken,
      }),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_DEPLOY_URL_INVALID" });
    expect(await readdir(root)).toEqual([]);
  });

  it("deletes only the recorded Worker from the recorded account and cleans up", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-cloudflare-"));
    directories.push(root);
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: CloudflareCommandRunner = {
      run: async (_file, args) => {
        mutableCalls.push([...args]);
        if (args.includes("auth"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("whoami"))
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authType: "OAuth Token",
              accounts: [{ id: "account-1", name: "Alice" }],
            }),
            stderr: "",
          };
        const configPath = args[args.indexOf("--config") + 1]!;
        expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
          name: "send-wechat-a1b2c3d4",
          account_id: "account-1",
        });
        return { exitCode: 0, stdout: "Deleted", stderr: "" };
      },
    };
    const provisioner = new CloudflareProvisioner({
      temporaryRoot: root,
      relayEntrypoint: "/package/dist/relay/worker.js",
      wranglerBin: "/wrangler.js",
      nodeExecutable: "/node",
      runner,
    });

    await expect(
      provisioner.deprovision({
        workerName: "send-wechat-a1b2c3d4",
        accountId: "account-1",
      }),
    ).resolves.toBeUndefined();
    expect(mutableCalls[2]).toEqual(
      expect.arrayContaining([
        "delete",
        "send-wechat-a1b2c3d4",
        "--force",
        "--config",
      ]),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("removes the exact new Worker when its health check fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "send-wechat-cloudflare-"));
    directories.push(root);
    const calls: string[][] = [];
    const runner: CloudflareCommandRunner = {
      run: async (_file, args, options) => {
        calls.push([...args]);
        if (args.includes("auth"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("whoami"))
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authType: "OAuth Token",
              accounts: [{ id: "account-1", name: "Alice" }],
            }),
            stderr: "",
          };
        if (args.includes("deploy")) {
          await writeFile(
            options.env!.WRANGLER_OUTPUT_FILE_PATH!,
            `${JSON.stringify({
              type: "deploy",
              version: 1,
              worker_name: "send-wechat-a1b2c3d4",
              targets: ["https://send-wechat-a1b2c3d4.alice.workers.dev"],
            })}\n`,
            "utf8",
          );
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const provisioner = new CloudflareProvisioner({
      temporaryRoot: root,
      relayEntrypoint: "/package/dist/relay/worker.js",
      wranglerBin: "/wrangler.js",
      nodeExecutable: "/node",
      runner,
      probe: async () => {
        throw new CloudflareProvisioningError("CLOUDFLARE_HEALTHCHECK_FAILED");
      },
    });

    await expect(
      provisioner.provision({
        workerName: "send-wechat-a1b2c3d4",
        hubAuthToken,
      }),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_HEALTHCHECK_FAILED" });
    expect(calls.find((args) => args.includes("delete"))).toEqual(
      expect.arrayContaining([
        "delete",
        "send-wechat-a1b2c3d4",
        "--force",
        "--config",
      ]),
    );
    expect(await readdir(root)).toEqual([]);
  });
});
