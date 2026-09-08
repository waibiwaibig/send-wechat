import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { APP_VERSION } from "../app/version.js";
import { loadCapability } from "../ipc/capability.js";
import { requestIpc, type IpcClientPayload } from "../ipc/transport.js";
import type { PlatformPaths } from "../platform/paths.js";
import { CodexAppServer } from "./codex-client.js";
import { GatewayController } from "./controller.js";
import { gatewayPaths } from "./paths.js";
import {
  JsonGatewayStateStore,
  gatewayConfigSchema,
  readGatewayFile,
  writeGatewayFile,
  type GatewayConfig,
} from "./storage.js";

const inboxResultSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        text: z
          .string()
          .min(1)
          .refine((value) => Array.from(value).length <= 4000),
        receivedAt: z.number().int().nonnegative(),
      }),
    )
    .max(50),
  overflow: z.boolean(),
});

export const gatewayStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  phase: z.enum(["starting", "ready", "stopped", "error"]),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  lastError: z.string().nullable(),
});

export function gatewayErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const candidate: unknown = "code" in error ? error.code : error.message;
    if (
      typeof candidate === "string" &&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)
    )
      return candidate;
  }
  return "GATEWAY_FAILURE";
}

function unwrap(response: unknown): unknown {
  const envelope = z
    .object({
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.object({ code: z.string() }).optional(),
    })
    .parse(response);
  if (!envelope.ok)
    throw new Error(envelope.error?.code ?? "GATEWAY_HUB_REQUEST_FAILED");
  return envelope.result;
}

export async function runGateway(
  config: GatewayConfig,
  hub: PlatformPaths,
  signal: AbortSignal,
): Promise<void> {
  const paths = gatewayPaths(hub);
  const assertCurrentInstallation = async (): Promise<void> => {
    const current = await readGatewayFile(paths.config, gatewayConfigSchema);
    if (current?.installationId !== config.installationId) {
      throw new Error("GATEWAY_CONFIGURATION_REPLACED");
    }
  };
  await assertCurrentInstallation();
  const consumerId = randomUUID();
  const capability = await loadCapability(hub.capabilityFile);
  const request = async (
    payload: IpcClientPayload,
    timeoutMs = 5000,
  ): Promise<unknown> =>
    requestIpc({
      endpoint: hub.ipcEndpoint,
      capability,
      appVersion: APP_VERSION,
      requestId: randomUUID(),
      payload,
      timeoutMs,
    });

  // Acquire exclusive input consumption before creating any Codex process.
  const initial = inboxResultSchema.parse(
    unwrap(await request({ command: "inbox_poll", consumerId })),
  );
  let phase: "starting" | "ready" | "stopped" | "error" = "starting";
  let runtimeError: string | null = initial.overflow
    ? "GATEWAY_INBOX_OVERFLOW"
    : null;
  let processing: Promise<void> | undefined;
  let processingError: Error | undefined;
  let lastStatusAt = 0;
  const controller = new GatewayController({
    codex: new CodexAppServer({
      executable: config.codexExecutable,
      cwd: config.workingDirectory,
      env: { ...process.env, PATH: config.searchPath },
    }),
    store: new JsonGatewayStateStore(paths.state, assertCurrentInstallation),
    send: async (text, idempotencyKey) => {
      unwrap(
        await request({ command: "send_text", text, idempotencyKey }, 30_000),
      );
    },
    onError: (code) => {
      runtimeError = code;
    },
  });
  const writeStatus = async (): Promise<void> => {
    await assertCurrentInstallation();
    const current = controller.status();
    await writeGatewayFile(paths.status, gatewayStatusSchema, {
      schemaVersion: 1,
      pid: process.pid,
      updatedAt: Date.now(),
      phase,
      threadId: current.threadId,
      turnId: current.turnId,
      lastError: runtimeError ?? current.lastError,
    });
    lastStatusAt = Date.now();
  };
  try {
    await writeStatus();
    await controller.initialize();
    phase = "ready";
    await writeStatus();
    while (!signal.aborted) {
      if (processingError !== undefined) throw processingError;
      if (!controller.status().connected)
        throw new Error("GATEWAY_CODEX_DISCONNECTED");
      const poll = inboxResultSchema.parse(
        unwrap(await request({ command: "inbox_poll", consumerId })),
      );
      if (poll.overflow) runtimeError = "GATEWAY_INBOX_OVERFLOW";
      if (processing === undefined && poll.messages.length > 0) {
        processing = controller
          .accept(poll.messages)
          .then(async (ids) => {
            unwrap(await request({ command: "inbox_ack", consumerId, ids }));
          })
          .catch((error: unknown) => {
            processingError =
              error instanceof Error
                ? error
                : new Error(gatewayErrorCode(error));
          })
          .finally(() => {
            processing = undefined;
          });
      }
      if (Date.now() - lastStatusAt >= 5000) await writeStatus();
      await delay(500, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
    }
    phase = "stopped";
  } catch (error) {
    phase = "error";
    runtimeError = gatewayErrorCode(error);
    throw error;
  } finally {
    await controller.close().catch((error: unknown) => {
      runtimeError ??= gatewayErrorCode(error);
    });
    await processing;
    await request({ command: "inbox_release", consumerId }).catch(
      () => undefined,
    );
    await writeStatus();
  }
}
