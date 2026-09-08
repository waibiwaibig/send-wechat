import { createServer } from "node:http";

const requestedPort = Number(
  process.argv[process.argv.indexOf("--port") + 1] ?? 0,
);
let responseNumber = 0;

function outputItem(responseId, itemId, text, status) {
  return {
    id: itemId,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    response_id: responseId,
  };
}

function responseObject(responseId, item, status, output) {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: "gateway-test-model",
    output,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: null,
    metadata: {},
    ...(item === undefined ? {} : { output: [item] }),
  };
}

function event(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function streamResponse(response) {
  responseNumber += 1;
  const responseId = `resp_gateway_${responseNumber}`;
  const itemId = `msg_gateway_${responseNumber}`;
  const text = responseNumber === 1 ? "MOCK_OK" : "MOCK_OK_AGAIN";
  const inProgressItem = outputItem(responseId, itemId, "", "in_progress");
  const completedItem = outputItem(responseId, itemId, text, "completed");
  const created = responseObject(responseId, undefined, "in_progress", []);
  const completed = responseObject(responseId, completedItem, "completed", [
    completedItem,
  ]);
  completed.output = [completedItem];

  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "close",
    "content-type": "text/event-stream",
  });
  response.write(event("response.created", { response: created }));
  response.write(
    event("response.output_item.added", {
      output_index: 0,
      item: inProgressItem,
      sequence_number: 1,
    }),
  );
  response.write(
    event("response.content_part.added", {
      response_id: responseId,
      output_index: 0,
      content_index: 0,
      item_id: itemId,
      part: { type: "output_text", text: "", annotations: [] },
      sequence_number: 2,
    }),
  );
  response.write(
    event("response.output_text.delta", {
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
      sequence_number: 3,
    }),
  );
  response.write(
    event("response.output_text.done", {
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
      sequence_number: 4,
    }),
  );
  response.write(
    event("response.output_item.done", {
      response_id: responseId,
      output_index: 0,
      item: completedItem,
      sequence_number: 5,
    }),
  );
  response.end(
    event("response.completed", {
      response: completed,
      sequence_number: 6,
    }),
  );
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    request.resume();
    return;
  }
  request.resume();
  request.once("end", () => streamResponse(response));
});

server.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.stderr.write("server did not expose a TCP port\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`LISTENING ${address.port}\n`);
});
