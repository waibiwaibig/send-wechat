import { DurableObject } from "cloudflare:workers";

type Env = {
  PERSONAL_RELAY: DurableObjectNamespace<PersonalRelay>;
  HUB_AUTH_TOKEN: string;
};

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,11184811}$/;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const INTERNAL_HUB_HEADER = "x-send-wechat-internal-hub";

type PendingResponse = {
  resolve(response: Response): void;
  timer: ReturnType<typeof setTimeout>;
};

function jsonError(status: number, code: string, retryable: boolean): Response {
  return Response.json(
    { ok: false, error: { code, retryable } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

export class PersonalRelay extends DurableObject<Env> {
  private readonly pending = new Map<string, PendingResponse>();

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/hub") {
      if (
        request.headers.get(INTERNAL_HUB_HEADER) !== "1" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      )
        return jsonError(401, "HUB_UNAUTHORIZED", false);

      for (const existing of this.ctx.getWebSockets("hub"))
        existing.close(1012, "Hub connection replaced");
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["hub"]);
      server.serializeAttachment({ role: "hub" });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/request")
      return jsonError(404, "NOT_FOUND", false);

    const requestId = request.headers.get("x-send-wechat-request-id");
    if (
      requestId === null ||
      !REQUEST_ID.test(requestId) ||
      request.headers.get("content-type") !== "application/octet-stream"
    )
      return jsonError(400, "RELAY_REQUEST_INVALID", false);

    const hub = this.ctx.getWebSockets("hub").at(0);
    if (hub === undefined) return jsonError(503, "HUB_OFFLINE", true);

    if (this.pending.has(requestId))
      return jsonError(409, "RELAY_REQUEST_CONFLICT", false);
    const declaredSize = Number(request.headers.get("content-length") ?? "0");
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > MAX_FRAME_BYTES
    )
      return jsonError(413, "RELAY_FRAME_TOO_LARGE", false);
    const payload = new Uint8Array(await request.arrayBuffer());
    if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES)
      return jsonError(413, "RELAY_FRAME_TOO_LARGE", false);

    return await new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(jsonError(504, "HUB_TIMEOUT", true));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      try {
        hub.send(
          JSON.stringify({
            v: 1,
            type: "request",
            requestId,
            payload: bytesToBase64Url(payload),
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(jsonError(503, "HUB_OFFLINE", true));
      }
    });
  }

  public webSocketMessage(_socket: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (!isHubResultFrame(frame)) return;
    const pending = this.pending.get(frame.requestId);
    if (pending === undefined) return;
    if (frame.type === "error") {
      clearTimeout(pending.timer);
      this.pending.delete(frame.requestId);
      pending.resolve(jsonError(400, frame.error.code, frame.error.retryable));
      return;
    }
    let payload: Uint8Array;
    try {
      payload = base64UrlToBytes(frame.payload);
    } catch {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.requestId);
    pending.resolve(
      new Response(payload.slice().buffer, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/octet-stream",
        },
      }),
    );
  }

  public webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
    this.failPending();
  }

  public webSocketError(): void {
    this.failPending();
  }

  private failPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(jsonError(503, "HUB_OFFLINE", true));
    }
    this.pending.clear();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health")
      return Response.json(
        {
          ok: true,
          service: "send-wechat-personal-relay",
          version: 1,
        },
        { headers: { "cache-control": "no-store" } },
      );
    const relay = env.PERSONAL_RELAY.getByName("personal-relay");
    if (request.method === "GET" && url.pathname === "/v1/hub") {
      const authorization = request.headers.get("authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
      if (!(await secretsEqual(token, env.HUB_AUTH_TOKEN)))
        return jsonError(401, "HUB_UNAUTHORIZED", false);
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.set(INTERNAL_HUB_HEADER, "1");
      return relay.fetch(new Request(request, { headers }));
    }
    return relay.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function secretsEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1)
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  return difference === 0 && left.length === right.length;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!BASE64URL.test(value)) throw new Error("invalid base64url");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  if (binary.length > MAX_FRAME_BYTES) throw new Error("frame too large");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isHubResultFrame(value: unknown): value is
  | { v: 1; type: "response"; requestId: string; payload: string }
  | {
      v: 1;
      type: "error";
      requestId: string;
      error: { code: string; retryable: boolean };
    } {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  if (
    frame.v !== 1 ||
    typeof frame.requestId !== "string" ||
    !REQUEST_ID.test(frame.requestId)
  )
    return false;
  if (frame.type === "response")
    return (
      Object.keys(frame).length === 4 &&
      typeof frame.payload === "string" &&
      BASE64URL.test(frame.payload)
    );
  if (
    frame.type !== "error" ||
    Object.keys(frame).length !== 4 ||
    typeof frame.error !== "object" ||
    frame.error === null
  )
    return false;
  const error = frame.error as Record<string, unknown>;
  return (
    Object.keys(error).length === 2 &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) &&
    typeof error.retryable === "boolean"
  );
}
