import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { fetchWithSystemProxy } from "../platform/network.js";

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const whoamiSchema = z
  .object({
    loggedIn: z.literal(true),
    authType: z.literal("OAuth Token"),
    accounts: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9_-]+$/),
            name: z.string().min(1).max(256),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
const deployOutputSchema = z
  .object({
    type: z.literal("deploy"),
    version: z.literal(1),
    worker_name: z.string(),
    targets: z.array(z.string()),
  })
  .passthrough();

export type CloudflareAccount = { readonly id: string; readonly name: string };
export type CloudflareCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
export type CloudflareCommandRunner = {
  run(
    file: string,
    args: readonly string[],
    options: {
      readonly mode: "capture" | "inherit" | "tee";
      readonly cwd: string;
      readonly env?: NodeJS.ProcessEnv;
    },
  ): Promise<CloudflareCommandResult>;
};

export type CloudflareProvisioningProgress = {
  readonly stage: "health_check";
  readonly attempt: number;
  readonly maxAttempts: number;
};

export type CloudflareProvisionerDependencies = {
  readonly temporaryRoot: string;
  readonly relayEntrypoint?: string;
  readonly wranglerBin?: string;
  readonly nodeExecutable?: string;
  readonly runner?: CloudflareCommandRunner;
  readonly selectAccount?: (
    accounts: readonly CloudflareAccount[],
  ) => Promise<string>;
  readonly probe?: (
    healthUrl: string,
    onProgress: (progress: CloudflareProvisioningProgress) => Promise<void>,
  ) => Promise<void>;
  readonly onProgress?: (
    progress: CloudflareProvisioningProgress,
  ) => Promise<void> | void;
};

export class CloudflareProvisioningError extends Error {
  public constructor(
    public readonly code: string,
    public readonly accounts?: readonly CloudflareAccount[],
  ) {
    super(code);
    this.name = "CloudflareProvisioningError";
  }
}

export class CloudflareProvisioner {
  private readonly relayEntrypoint: string;
  private readonly wranglerBin: string;
  private readonly nodeExecutable: string;
  private readonly runner: CloudflareCommandRunner;
  private readonly probe: (
    healthUrl: string,
    onProgress: (progress: CloudflareProvisioningProgress) => Promise<void>,
  ) => Promise<void>;

  public constructor(
    private readonly dependencies: CloudflareProvisionerDependencies,
  ) {
    this.relayEntrypoint =
      dependencies.relayEntrypoint ??
      fileURLToPath(new URL("./worker.js", import.meta.url));
    this.wranglerBin = dependencies.wranglerBin ?? resolveWranglerBin();
    this.nodeExecutable = dependencies.nodeExecutable ?? process.execPath;
    this.runner = dependencies.runner ?? defaultCloudflareCommandRunner;
    this.probe = dependencies.probe ?? probeRelayHealth;
  }

  public async provision(input: {
    workerName: string;
    hubAuthToken: string;
  }): Promise<{
    accountId: string;
    relayUrl: string;
    workerName: string;
  }> {
    if (
      !WORKER_NAME.test(input.workerName) ||
      !BASE64URL_KEY.test(input.hubAuthToken)
    )
      throw new CloudflareProvisioningError("CLOUDFLARE_INPUT_INVALID");

    await mkdir(this.dependencies.temporaryRoot, {
      recursive: true,
      mode: 0o700,
    });
    if (process.platform !== "win32")
      await chmod(this.dependencies.temporaryRoot, 0o700);
    const accounts = await this.authenticate();
    const accountId = await this.chooseAccount(accounts);
    const workspace = await mkdtemp(
      join(this.dependencies.temporaryRoot, "cloudflare-"),
    );
    if (process.platform !== "win32") await chmod(workspace, 0o700);
    const configPath = join(workspace, "wrangler.json");
    const secretPath = join(workspace, "secrets.json");
    const outputPath = join(workspace, "wrangler-output.jsonl");
    let deployed = false;
    try {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            name: input.workerName,
            main: this.relayEntrypoint,
            compatibility_date: "2026-08-24",
            workers_dev: true,
            account_id: accountId,
            durable_objects: {
              bindings: [
                {
                  name: "PERSONAL_RELAY",
                  class_name: "PersonalRelay",
                },
              ],
            },
            exports: {
              PersonalRelay: {
                type: "durable-object",
                storage: "sqlite",
              },
            },
          },
          null,
          2,
        ),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await writeFile(
        secretPath,
        JSON.stringify({ HUB_AUTH_TOKEN: input.hubAuthToken }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      const result = await this.run(
        [
          this.wranglerBin,
          "deploy",
          "--config",
          configPath,
          "--secrets-file",
          secretPath,
          "--strict",
          "--no-autoconfig",
        ],
        "inherit",
        workspace,
        {
          ...process.env,
          WRANGLER_OUTPUT_FILE_PATH: outputPath,
        },
      );
      if (result.exitCode !== 0)
        throw new CloudflareProvisioningError("CLOUDFLARE_DEPLOY_FAILED");
      deployed = true;
      const relayUrl = extractRelayUrl(
        await readFile(outputPath, "utf8"),
        input.workerName,
      );
      await this.probe(
        `${relayUrl}/v1/health`,
        async (progress) => await this.dependencies.onProgress?.(progress),
      );
      return { accountId, relayUrl, workerName: input.workerName };
    } catch (error) {
      if (deployed) {
        try {
          const rollback = await this.run(
            [
              this.wranglerBin,
              "delete",
              input.workerName,
              "--force",
              "--config",
              configPath,
            ],
            "tee",
            workspace,
          );
          if (rollback.exitCode !== 0)
            throw new CloudflareProvisioningError("CLOUDFLARE_ROLLBACK_FAILED");
        } catch {
          throw new CloudflareProvisioningError("CLOUDFLARE_ROLLBACK_FAILED");
        }
      }
      if (error instanceof CloudflareProvisioningError) throw error;
      throw new CloudflareProvisioningError("CLOUDFLARE_DEPLOY_FAILED");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  public async deprovision(input: {
    workerName: string;
    accountId: string;
  }): Promise<void> {
    if (
      !WORKER_NAME.test(input.workerName) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.accountId)
    )
      throw new CloudflareProvisioningError("CLOUDFLARE_INPUT_INVALID");
    await mkdir(this.dependencies.temporaryRoot, {
      recursive: true,
      mode: 0o700,
    });
    if (process.platform !== "win32")
      await chmod(this.dependencies.temporaryRoot, 0o700);
    const accounts = await this.authenticate();
    if (!accounts.some(({ id }) => id === input.accountId))
      throw new CloudflareProvisioningError("CLOUDFLARE_ACCOUNT_INVALID");
    const workspace = await mkdtemp(
      join(this.dependencies.temporaryRoot, "cloudflare-delete-"),
    );
    if (process.platform !== "win32") await chmod(workspace, 0o700);
    const configPath = join(workspace, "wrangler.json");
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          name: input.workerName,
          account_id: input.accountId,
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      const result = await this.run(
        [
          this.wranglerBin,
          "delete",
          input.workerName,
          "--force",
          "--config",
          configPath,
        ],
        "tee",
        workspace,
      );
      if (result.exitCode !== 0)
        throw new CloudflareProvisioningError("CLOUDFLARE_DELETE_FAILED");
    } catch (error) {
      if (error instanceof CloudflareProvisioningError) throw error;
      throw new CloudflareProvisioningError("CLOUDFLARE_DELETE_FAILED");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private async authenticate(): Promise<readonly CloudflareAccount[]> {
    const keyring = await this.run(
      [this.wranglerBin, "auth", "keyring", "enable"],
      "capture",
      this.dependencies.temporaryRoot,
    );
    if (keyring.exitCode !== 0)
      throw new CloudflareProvisioningError("CLOUDFLARE_KEYRING_UNAVAILABLE");
    let result = await this.run(
      [this.wranglerBin, "whoami", "--json"],
      "capture",
      this.dependencies.temporaryRoot,
    );
    if (result.exitCode !== 0) {
      const login = await this.run(
        [this.wranglerBin, "login", "--device", "--use-keyring"],
        "inherit",
        this.dependencies.temporaryRoot,
      );
      if (login.exitCode !== 0)
        throw new CloudflareProvisioningError("CLOUDFLARE_LOGIN_FAILED");
      result = await this.run(
        [this.wranglerBin, "whoami", "--json"],
        "capture",
        this.dependencies.temporaryRoot,
      );
    }
    if (result.exitCode !== 0)
      throw new CloudflareProvisioningError("CLOUDFLARE_LOGIN_FAILED");
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new CloudflareProvisioningError("CLOUDFLARE_ACCOUNT_INVALID");
    }
    const parsed = whoamiSchema.safeParse(raw);
    if (!parsed.success)
      throw new CloudflareProvisioningError("CLOUDFLARE_ACCOUNT_INVALID");
    return parsed.data.accounts.map(({ id, name }) => ({ id, name }));
  }

  private async chooseAccount(
    accounts: readonly CloudflareAccount[],
  ): Promise<string> {
    if (accounts.length === 1) return accounts[0]!.id;
    if (this.dependencies.selectAccount === undefined)
      throw new CloudflareProvisioningError(
        "CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED",
        accounts,
      );
    const selected = await this.dependencies.selectAccount(accounts);
    if (!accounts.some(({ id }) => id === selected))
      throw new CloudflareProvisioningError("CLOUDFLARE_ACCOUNT_INVALID");
    return selected;
  }

  private run(
    args: readonly string[],
    mode: "capture" | "inherit" | "tee",
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<CloudflareCommandResult> {
    return this.runner.run(this.nodeExecutable, args, {
      mode,
      cwd,
      ...(env === undefined ? {} : { env }),
    });
  }
}

const defaultCloudflareCommandRunner: CloudflareCommandRunner = {
  run(file, args, options) {
    return new Promise((resolve, reject) => {
      const inherited = options.mode === "inherit";
      const child = spawn(file, [...args], {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        shell: false,
        stdio: inherited ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (options.mode === "tee") process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (options.mode === "tee") process.stderr.write(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ exitCode: code ?? -1, stdout, stderr }),
      );
    });
  },
};

function resolveWranglerBin(): string {
  const require = createRequire(import.meta.url);
  return join(
    dirname(require.resolve("wrangler/package.json")),
    "bin",
    "wrangler.js",
  );
}

function extractRelayUrl(output: string, workerName: string): string {
  const candidates: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new CloudflareProvisioningError("CLOUDFLARE_DEPLOY_URL_INVALID");
    }
    const entry = deployOutputSchema.safeParse(parsed);
    if (!entry.success || entry.data.worker_name !== workerName) continue;
    candidates.push(...entry.data.targets);
  }
  const relayUrls: string[] = [];
  for (const candidate of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (
      parsed.protocol === "https:" &&
      parsed.hostname.startsWith(`${workerName}.`) &&
      parsed.hostname.endsWith(".workers.dev") &&
      parsed.hostname.split(".").length >= 4 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    )
      relayUrls.push(parsed.toString().replace(/\/$/, ""));
  }
  if (relayUrls.length === 1) return relayUrls[0]!;
  throw new CloudflareProvisioningError("CLOUDFLARE_DEPLOY_URL_INVALID");
}

async function probeRelayHealth(
  healthUrl: string,
  onProgress: (progress: CloudflareProvisioningProgress) => Promise<void>,
): Promise<void> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await onProgress({
      stage: "health_check",
      attempt: attempt + 1,
      maxAttempts,
    });
    try {
      const response = await fetchWithSystemProxy(healthUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as unknown;
      if (
        response.ok &&
        JSON.stringify(body) ===
          JSON.stringify({
            ok: true,
            service: "send-wechat-personal-relay",
            version: 1,
          })
      )
        return;
    } catch {
      // Deployment propagation is retried below.
    }
    if (attempt < maxAttempts - 1)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(5_000, 1_000 * 2 ** attempt)),
      );
  }
  throw new CloudflareProvisioningError("CLOUDFLARE_HEALTHCHECK_FAILED");
}
