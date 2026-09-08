import { once } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServer,
  type CodexEvent,
  type ModelSelection,
} from "../src/gateway/codex-client.js";

const smokeBinary = process.env.CODEX_SMOKE_BINARY;
const modelServerFixture = fileURLToPath(
  new URL("./fixtures/gateway-model-server.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type FakeModelServer = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
};

async function startFakeModelServer(
  capturePath: string,
): Promise<FakeModelServer> {
  const child = spawn(process.execPath, [modelServerFixture, "--port", "0"], {
    shell: false,
    env: { ...process.env, FAKE_MODEL_CAPTURE_FILE: capturePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stderr.on("data", () => undefined);
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("fake model server did not start"));
      }, 2_000);
      timer.unref();
      lines.once("line", (line: string) => {
        clearTimeout(timer);
        const match = /^LISTENING ([0-9]+)$/.exec(line);
        if (!match) {
          reject(new Error("fake model server returned an invalid port"));
          return;
        }
        resolve(Number(match[1]));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { child, port };
  } finally {
    lines.close();
  }
}

async function stopChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "close"), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "close"), delay(500)]);
  }
}

function codexEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: codexHome,
    USERPROFILE: codexHome,
  };
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_API_TOKEN",
    "OPENAI_ACCESS_TOKEN",
    "CODEX_AUTH",
    "CODEX_API_KEY",
    "CHATGPT_API_KEY",
  ]) {
    delete environment[key];
  }
  return environment;
}

function collectStrings(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectStrings).join("\n");
  if (value !== null && typeof value === "object") {
    return Object.values(value).map(collectStrings).join("\n");
  }
  return "";
}

function appServerArgs(port: number): string[] {
  return [
    "-c",
    "model_provider='gateway_test'",
    "-c",
    "model_providers.gateway_test.name='gateway_test'",
    "-c",
    `model_providers.gateway_test.base_url='http://127.0.0.1:${port}/v1'`,
    "-c",
    "model_providers.gateway_test.wire_api='responses'",
    "-c",
    "model_providers.gateway_test.requires_openai_auth=false",
    "app-server",
    "--stdio",
  ];
}

async function waitForEvent(
  events: CodexEvent[],
  predicate: (event: CodexEvent) => boolean,
): Promise<CodexEvent> {
  for (const event of events) {
    if (predicate(event)) return event;
  }
  return new Promise<CodexEvent>((resolve, reject) => {
    const interval = setInterval(() => {
      const event = events.find(predicate);
      if (event === undefined) return;
      clearTimeout(timer);
      clearInterval(interval);
      resolve(event);
    }, 10);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("expected Codex event was not received"));
    }, 8_000);
    timer.unref();
    interval.unref();
  });
}

describe.skipIf(smokeBinary === undefined)(
  "real Codex local-provider smoke",
  () => {
    it("completes a mocked Responses turn and resumes its thread after CLI restart", async () => {
      if (smokeBinary === undefined) {
        throw new Error("CODEX_SMOKE_BINARY must point to a Codex executable");
      }
      const root = await mkdtemp(
        path.join(tmpdir(), "send-wechat-codex-smoke-"),
      );
      temporaryDirectories.push(root);
      const codexHome = path.join(root, "codex-home");
      const workspace = path.join(root, "workspace");
      const modelCapture = path.join(root, "model-requests.jsonl");
      await Promise.all([mkdir(codexHome), mkdir(workspace)]);

      let modelServer: FakeModelServer | undefined;
      let firstClient: CodexAppServer | undefined;
      let secondClient: CodexAppServer | undefined;
      try {
        modelServer = await startFakeModelServer(modelCapture);
        const environment = {
          ...codexEnvironment(codexHome),
          FAKE_MODEL_CAPTURE_FILE: modelCapture,
        };
        const args = appServerArgs(modelServer.port);
        const executable = smokeBinary;
        const firstEvents: CodexEvent[] = [];
        firstClient = new CodexAppServer({
          executable,
          cwd: workspace,
          args,
          env: environment,
          requestTimeoutMs: 8_000,
        });
        firstClient.onEvent((event) => firstEvents.push(event));
        await firstClient.connect();
        const selection: ModelSelection = {
          model: "gateway-test-model",
          effort: "high",
        };
        const threadId = await firstClient.createThread(selection, "full");
        const firstTurnPromise = firstClient.startTurn(
          threadId,
          "Reply with exactly MOCK_OK.",
          selection,
          "full",
        );
        const firstCompletedPromise = waitForEvent(
          firstEvents,
          (event) => event.type === "turn-completed",
        );
        const firstTurnId = await firstTurnPromise;
        const firstCompleted = await firstCompletedPromise;
        expect(firstCompleted).toMatchObject({
          type: "turn-completed",
          threadId,
          turnId: firstTurnId,
          status: "completed",
        });
        expect(firstEvents).toContainEqual({
          type: "delta",
          threadId,
          turnId: firstTurnId,
          itemId: expect.any(String),
          text: "MOCK_OK",
        });
        expect(firstEvents).toContainEqual({
          type: "message-completed",
          threadId,
          turnId: firstTurnId,
          itemId: expect.any(String),
          text: "MOCK_OK",
        });
        const skillText = await readFile(
          path.join(process.cwd(), ".agents/skills/wechat-connection/SKILL.md"),
          "utf8",
        );
        const capturedRequests = (await readFile(modelCapture, "utf8"))
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const skillBody = skillText
          .replace(/^---\n[\s\S]*?\n---\n?/, "")
          .trim();
        const capturedInput = collectStrings(capturedRequests[0]);
        expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
        expect(capturedRequests[0]).toMatchObject({
          model: selection.model,
          reasoning: { effort: selection.effort },
        });
        expect(capturedInput).toContain(skillBody);
        await firstClient.close();
        firstClient = undefined;

        const secondEvents: CodexEvent[] = [];
        secondClient = new CodexAppServer({
          executable,
          cwd: workspace,
          args,
          env: environment,
          requestTimeoutMs: 8_000,
        });
        secondClient.onEvent((event) => secondEvents.push(event));
        await secondClient.connect();
        await expect(
          secondClient.resumeThread(threadId),
        ).resolves.toMatchObject({
          model: expect.any(String),
          effort: expect.anything(),
        });
        const secondTurnPromise = secondClient.startTurn(
          threadId,
          "Reply with exactly MOCK_OK_AGAIN.",
        );
        const secondCompletedPromise = waitForEvent(
          secondEvents,
          (event) => event.type === "turn-completed",
        );
        const secondTurnId = await secondTurnPromise;
        const secondCompleted = await secondCompletedPromise;
        expect(secondCompleted).toMatchObject({
          type: "turn-completed",
          threadId,
          turnId: secondTurnId,
          status: "completed",
        });
        expect(secondEvents).toContainEqual({
          type: "message-completed",
          threadId,
          turnId: secondTurnId,
          itemId: expect.any(String),
          text: "MOCK_OK_AGAIN",
        });
      } finally {
        await firstClient?.close().catch(() => undefined);
        await secondClient?.close().catch(() => undefined);
        if (modelServer !== undefined) await stopChild(modelServer.child);
      }
    }, 30_000);
  },
);
