import readline from "node:readline";
import { appendFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

const mode = process.env.FAKE_CODEX_MODE ?? "normal";
const MAX_FRAME_BYTES = 1_048_576;
const skillRootSuffix = join(".agents", "skills");
const connectionSkillSuffix = join(
  skillRootSuffix,
  "wechat-connection",
  "SKILL.md",
);
const skillRootPathSuffix = `${sep}${skillRootSuffix}`;
const connectionSkillPathSuffix = `${sep}${connectionSkillSuffix}`;
let nextThread = 1;
let nextTurn = 1;
let pendingServerRequest = null;
let pendingTurnRequest = null;
let lastServerResponse = null;
const resumedThreads = new Set();
const createdThreads = new Set();
const turnCounts = new Map();

function send(message, ending = "\n") {
  process.stdout.write(`${JSON.stringify(message)}${ending}`);
}

function response(id, result) {
  send({ id, result });
}

function errorResponse(id, code, message) {
  send({ id, error: { code, message } });
}

function thread(id) {
  return {
    id,
    cliVersion: "fake",
    createdAt: 1,
    cwd: process.cwd(),
    ephemeral: false,
    modelProvider: "fake",
    preview: "",
    projectId: null,
    sessionId: id,
    source: "cli",
    status: { type: "idle" },
    turns: [],
    updatedAt: 1,
  };
}

function threadResponse(id, reasoningEffort = "medium") {
  return {
    thread: thread(id),
    model: "fake-model",
    modelProvider: "fake",
    serviceTier: null,
    cwd: process.cwd(),
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort,
  };
}

function model(
  modelId,
  displayName,
  isDefault,
  defaultReasoningEffort = "medium",
) {
  return {
    id: modelId,
    model: modelId,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description: displayName,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "low" },
      { reasoningEffort: "medium", description: "medium" },
      { reasoningEffort: "high", description: "high" },
    ],
    defaultReasoningEffort,
    inputModalities: ["text"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}

const MODEL_ONE = model("fake-model", "Fake Model", true);
const MODEL_TWO = model("fake-model-2", "Fake Model Two", false, "high");

function modelListPage(cursor) {
  if (mode === "model-pages") {
    if (cursor === undefined) {
      return { data: [MODEL_ONE], nextCursor: "page-2" };
    }
    if (cursor === "page-2") {
      return { data: [MODEL_TWO], nextCursor: null };
    }
  }
  if (mode === "model-repeat") {
    return { data: [MODEL_ONE], nextCursor: "page-1" };
  }
  if (mode === "model-many") {
    const page = cursor === undefined ? 1 : Number(cursor);
    return { data: [MODEL_ONE], nextCursor: String(page + 1) };
  }
  if (mode === "model-invalid-data") {
    return { data: "invalid", nextCursor: null };
  }
  if (mode === "model-invalid-cursor") {
    return { data: [MODEL_ONE], nextCursor: 1 };
  }
  return { data: [MODEL_ONE, MODEL_TWO], nextCursor: null };
}

function configResponse() {
  switch (mode) {
    case "config-values":
      return {
        model: "configured-model",
        model_reasoning_effort: "high",
      };
    case "config-model":
      return { model: "fake-model-2", model_reasoning_effort: null };
    case "config-effort":
      return { model: null, model_reasoning_effort: "low" };
    case "config-invalid":
      return { model: 42, model_reasoning_effort: null };
    default:
      return { model: null, model_reasoning_effort: null };
  }
}

function capture(message) {
  const capturePath = process.env.FAKE_CODEX_CAPTURE_FILE;
  if (!capturePath) return;
  appendFileSync(
    capturePath,
    `${JSON.stringify({ method: message.method, params: message.params ?? null })}\n`,
  );
}

function invalidPayload(message, expected) {
  if (mode === "validate-null-selection" && message.method === "thread/start") {
    const params = message.params ?? {};
    if (params.model !== expected.model || Object.hasOwn(params, "config")) {
      errorResponse(message.id, -32007, "invalid null selection payload");
      return true;
    }
  }
  if (mode === "validate-selection") {
    const params = message.params ?? {};
    if (
      params.model !== expected.model ||
      params.config?.model_reasoning_effort !== expected.effort
    ) {
      errorResponse(message.id, -32003, "invalid selection payload");
      return true;
    }
  }
  if (mode === "validate-turn-selection" && message.method === "turn/start") {
    const params = message.params ?? {};
    if (params.model !== expected.model || params.effort !== expected.effort) {
      errorResponse(message.id, -32003, "invalid turn selection payload");
      return true;
    }
  }
  if (
    mode === "validate-permission" &&
    (message.method === "thread/start" || message.method === "turn/start")
  ) {
    const params = message.params ?? {};
    const permission = process.env.FAKE_CODEX_PERMISSION ?? "full";
    const expectedMode =
      permission === "full"
        ? "danger-full-access"
        : permission === "workspace"
          ? "workspace-write"
          : "read-only";
    if (message.method === "thread/start") {
      if (
        params.approvalPolicy !== "never" ||
        params.sandbox !== expectedMode
      ) {
        errorResponse(message.id, -32004, "invalid thread permission payload");
        return true;
      }
    } else {
      const expectedType =
        permission === "full"
          ? "dangerFullAccess"
          : permission === "workspace"
            ? "workspaceWrite"
            : "readOnly";
      if (
        params.approvalPolicy !== "never" ||
        params.sandboxPolicy?.type !== expectedType ||
        (permission === "workspace" &&
          JSON.stringify(params.sandboxPolicy.writableRoots) !==
            JSON.stringify([process.cwd()])) ||
        (permission === "workspace" &&
          (params.sandboxPolicy.excludeTmpdirEnvVar !== true ||
            params.sandboxPolicy.excludeSlashTmp !== true))
      ) {
        errorResponse(message.id, -32004, "invalid turn permission payload");
        return true;
      }
    }
  }
  if (
    (mode === "validate-bootstrap" || mode === "bootstrap-error") &&
    message.method === "turn/start"
  ) {
    const params = message.params ?? {};
    const threadId = params.threadId;
    const count = turnCounts.get(threadId) ?? 0;
    const input = params.input;
    const resumed = resumedThreads.has(threadId);
    const wantsSkill = createdThreads.has(threadId) && !resumed && count === 0;
    const valid =
      Array.isArray(input) &&
      input.length === (wantsSkill ? 2 : 1) &&
      (wantsSkill
        ? input[0]?.type === "skill" &&
          input[0]?.name === "wechat-connection" &&
          typeof input[0]?.path === "string" &&
          isAbsolute(input[0].path) &&
          input[0].path.endsWith(connectionSkillPathSuffix) &&
          input[1]?.type === "text" &&
          input[1]?.text === "hello"
        : input[0]?.type === "text" && input[0]?.text === "hello");
    if (!valid) {
      errorResponse(message.id, -32005, "invalid bootstrap skill payload");
      return true;
    }
    if (mode === "bootstrap-error" && count === 0) {
      turnCounts.set(threadId, 1);
      errorResponse(message.id, -32006, "bootstrap turn failed");
      return true;
    }
  }
  return false;
}

function turn(id, status = "inProgress") {
  return { id, items: [], status };
}

function serverRequestSpec() {
  switch (mode) {
    case "approval-request":
      return {
        id: 91,
        method: "item/commandExecution/requestApproval",
        result: { decision: "decline" },
      };
    case "approval-file":
      return {
        id: 92,
        method: "item/fileChange/requestApproval",
        result: { decision: "decline" },
      };
    case "approval-permissions":
      return {
        id: 93,
        method: "item/permissions/requestApproval",
        result: {
          permissions: { fileSystem: null, network: null },
          scope: "turn",
        },
      };
    case "approval-user-input":
      return {
        id: 94,
        method: "item/tool/requestUserInput",
        result: { answers: {} },
      };
    case "approval-elicitation":
      return {
        id: 95,
        method: "mcpServer/elicitation/request",
        result: { action: "decline" },
      };
    case "dynamic-tool":
      return {
        id: 96,
        method: "item/tool/call",
        result: { success: false, contentItems: [] },
      };
    case "known-refresh":
      return {
        id: 97,
        method: "account/chatgptAuthTokens/refresh",
        error: {
          code: -32000,
          message:
            "Unsupported server request: account/chatgptAuthTokens/refresh",
        },
      };
    case "known-attestation":
      return {
        id: 98,
        method: "attestation/generate",
        error: {
          code: -32000,
          message: "Unsupported server request: attestation/generate",
        },
      };
    case "unknown-request":
      return {
        id: 90,
        method: "server/unknown",
        error: { code: -32601, message: "Method not found: server/unknown" },
      };
    case "approval-no-context":
      return {
        id: 99,
        method: "item/tool/requestUserInput",
        params: null,
        result: { answers: {} },
      };
    default:
      return null;
  }
}

function sendServerRequest() {
  const spec = serverRequestSpec();
  if (!spec) return;
  pendingServerRequest = spec.id;
  const params =
    "params" in spec ? spec.params : { threadId: "thread-1", turnId: "turn-1" };
  send({ id: spec.id, method: spec.method, params });
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function acceptsServerResponse(message) {
  const spec = serverRequestSpec();
  if (!spec) return true;
  if ("error" in spec) {
    return (
      message.error &&
      message.error.code === spec.error.code &&
      message.error.message === spec.error.message
    );
  }
  return "result" in message && equalJson(message.result, spec.result);
}

function finishTurnRequest() {
  if (pendingTurnRequest === null) return;
  if (!acceptsServerResponse(lastServerResponse)) {
    errorResponse(pendingTurnRequest, -32001, "invalid server response");
  } else {
    response(pendingTurnRequest, { turn: turn("turn-1") });
  }
  pendingTurnRequest = null;
  lastServerResponse = null;
}

function sendNormalTurn(message, fragmented = false) {
  const threadId = message.params.threadId;
  const turnId = `turn-${nextTurn++}`;
  const itemId = "item-1";
  send({ method: "turn/started", params: { threadId, turn: turn(turnId) } });
  const delta = {
    method: "item/agentMessage/delta",
    params: {
      threadId,
      turnId,
      itemId,
      delta: fragmented ? "你好🌟" : "hello",
    },
  };
  if (fragmented) {
    const bytes = Buffer.from(`${JSON.stringify(delta)}\r\n`, "utf8");
    const marker = Buffer.from("🌟", "utf8");
    const markerStart = bytes.indexOf(marker);
    const split = markerStart + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(split));
      sendRemainingTurnFrames();
    }, 5);
  } else {
    send(delta);
    sendRemainingTurnFrames();
  }

  function sendRemainingTurnFrames() {
    send({
      method: "item/completed",
      params: {
        completedAtMs: 1,
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          id: itemId,
          text: fragmented ? "你好🌟" : "hello world",
        },
      },
    });
    send(
      {
        method: "turn/completed",
        params: { threadId, turn: turn(turnId, "completed") },
      },
      fragmented ? "\r\n" : "\n",
    );
    response(message.id, { turn: turn(turnId) });
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  capture(message);

  if (
    message.id !== undefined &&
    (message.result !== undefined || message.error !== undefined) &&
    pendingServerRequest === message.id
  ) {
    pendingServerRequest = null;
    lastServerResponse = message;
    finishTurnRequest();
    return;
  }

  if (!message.method) return;
  if (message.method === "initialize") {
    if (mode === "exit-initialize") process.exit(0);
    response(message.id, {
      codexHome: process.cwd(),
      platformFamily: "unix",
      platformOs: "fake",
      userAgent: "fake",
    });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "skills/extraRoots/set") {
    if (mode === "registration-error") {
      errorResponse(message.id, 400, "skill registration failed");
      return;
    }
    if (
      mode === "validate-bootstrap" &&
      (!Array.isArray(message.params?.extraRoots) ||
        message.params.extraRoots.length !== 1 ||
        typeof message.params.extraRoots[0] !== "string" ||
        !isAbsolute(message.params.extraRoots[0]) ||
        !message.params.extraRoots[0].endsWith(skillRootPathSuffix))
    ) {
      errorResponse(message.id, -32008, "invalid skill extra roots payload");
      return;
    }
    response(message.id, {});
    return;
  }
  if (message.method === "model/list") {
    if (mode === "model-error") {
      errorResponse(message.id, 400, "model list failed");
      return;
    }
    response(message.id, modelListPage(message.params?.cursor));
    return;
  }
  if (message.method === "config/read") {
    if (mode === "config-error") {
      errorResponse(message.id, 400, "config read failed");
      return;
    }
    if (
      mode === "config-payload" &&
      (message.params?.cwd !== process.cwd() ||
        message.params?.includeLayers !== false)
    ) {
      errorResponse(message.id, -32002, "invalid config/read payload");
      return;
    }
    response(message.id, {
      config: configResponse(),
      origins: {},
      layers: null,
    });
    return;
  }
  if (message.method === "thread/start") {
    if (mode === "timeout" || mode === "timeout-all") return;
    if (mode === "exit-thread") {
      process.exit(0);
      return;
    }
    if (mode === "response-error") {
      errorResponse(message.id, 400, "thread failed");
      return;
    }
    if (mode === "missing-thread") {
      response(message.id, {});
      return;
    }
    if (
      invalidPayload(message, {
        model: "selected-model",
        effort: "high",
      })
    ) {
      return;
    }
    const threadId = `thread-${nextThread++}`;
    createdThreads.add(threadId);
    response(message.id, threadResponse(threadId));
    return;
  }
  if (message.method === "thread/resume") {
    if (mode === "timeout-all") return;
    resumedThreads.add(message.params.threadId);
    response(message.id, threadResponse(message.params.threadId));
    return;
  }
  if (message.method === "turn/start") {
    if (mode === "timeout" || mode === "timeout-all") return;
    if (mode === "missing-turn") {
      response(message.id, {});
      return;
    }
    if (mode === "bad-json") {
      process.stdout.write("{bad-json\n");
      return;
    }
    if (mode === "invalid-delta") {
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1" },
      });
      return;
    }
    if (mode === "invalid-turn-completed") {
      send({ method: "turn/completed", params: { threadId: "thread-1" } });
      return;
    }
    if (mode === "invalid-completed") {
      send({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item: {} },
      });
      response(message.id, { turn: turn("turn-1") });
      return;
    }
    if (mode === "invalid-array") {
      send([]);
      return;
    }
    if (mode === "invalid-message") {
      send({ id: 123 });
      return;
    }
    if (mode === "oversized-buffer") {
      process.stdout.write("x".repeat(MAX_FRAME_BYTES + 1));
      return;
    }
    if (mode === "oversized-line") {
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "x".repeat(MAX_FRAME_BYTES + 1),
        },
      });
      return;
    }
    if (mode === "exit") {
      process.exit(0);
      return;
    }
    if (
      invalidPayload(message, {
        model: "selected-model",
        effort: "high",
      })
    ) {
      return;
    }
    turnCounts.set(
      message.params.threadId,
      (turnCounts.get(message.params.threadId) ?? 0) + 1,
    );
    if (mode === "unknown-response") send({ id: 999, result: {} });
    if (serverRequestSpec()) {
      pendingTurnRequest = message.id;
      sendServerRequest();
      return;
    }
    sendNormalTurn(message, mode === "fragmented");
    return;
  }
  if (message.method === "turn/interrupt") response(message.id, {});
});
