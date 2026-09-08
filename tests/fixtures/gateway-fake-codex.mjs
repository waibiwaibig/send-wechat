import readline from "node:readline";

const mode = process.env.FAKE_CODEX_MODE ?? "normal";
const MAX_FRAME_BYTES = 1_048_576;
let nextThread = 1;
let nextTurn = 1;
let pendingServerRequest = null;
let pendingTurnRequest = null;
let lastServerResponse = null;

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
    response(message.id, { thread: thread(`thread-${nextThread++}`) });
    return;
  }
  if (message.method === "thread/resume") {
    if (mode === "timeout-all") return;
    response(message.id, { thread: thread(message.params.threadId) });
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
