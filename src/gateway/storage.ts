import { isAbsolute } from "node:path";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "../storage/private-json.js";

const absolutePath = z.string().min(1).max(16_384).refine(isAbsolute);

export const gatewayConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installationId: z.string().uuid(),
  channel: z.enum(["wechat", "feishu"]),
  permission: z.enum(["full", "workspace", "read-only"]),
  codexExecutable: absolutePath,
  workingDirectory: absolutePath,
  searchPath: z.string().max(64 * 1024),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

const messageId = z.string().min(1).max(256);
export const gatewayStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  threadId: z.string().min(1).max(256).nullable(),
  // Absent means inherit Codex's current thread/config selection.
  selection: z
    .strictObject({
      model: z.string().min(1).max(256),
      effort: z.string().min(1).max(64).nullable(),
    })
    .optional(),
  // An unselected secretary uses the configured initial permission.
  permission: z.enum(["full", "workspace", "read-only"]).optional(),
  // Absent preserves the historical default of incremental delivery.
  streamEnabled: z.boolean().optional(),
  handled: z.array(messageId).max(10_000),
  pending: z.array(messageId).max(50),
  lastError: z.string().max(128).nullable(),
});

export type GatewayState = z.infer<typeof gatewayStateSchema>;

export interface GatewayStateStore {
  load(): Promise<GatewayState>;
  save(state: GatewayState): Promise<void>;
}

export function emptyGatewayState(): GatewayState {
  return {
    schemaVersion: 1,
    threadId: null,
    handled: [],
    pending: [],
    lastError: null,
  };
}

export class JsonGatewayStateStore implements GatewayStateStore {
  public constructor(
    private readonly file: string,
    private readonly guard?: () => Promise<void>,
  ) {}

  public async load(): Promise<GatewayState> {
    await this.guard?.();
    return (
      (await readPrivateJson(this.file, gatewayStateSchema)) ??
      emptyGatewayState()
    );
  }

  public async save(state: GatewayState): Promise<void> {
    await this.guard?.();
    await writePrivateJson(this.file, gatewayStateSchema, state);
  }
}
