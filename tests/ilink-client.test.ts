import { describe, expect, it } from "vitest";

import { IlinkClient, IlinkProtocolError } from "../src/ilink/client.js";
import type { IlinkSendRequest } from "../src/runtime/ports.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textRequest(): IlinkSendRequest {
  return {
    binding: {
      botId: "bot-id",
      userId: "user-id",
      baseUrl: "https://ilinkai.weixin.qq.com",
      boundAt: "2026-08-24T00:00:00.000Z",
    },
    secret: {
      schemaVersion: 1,
      botToken: "bot-token",
      contextToken: "context-token",
    },
    payload: { type: "text", text: "hello" },
    clientId: "client-id",
  };
}

describe("iLink module interface", () => {
  it("rejects missing send context and classifies malformed or HTTP responses", async () => {
    const client = new IlinkClient({
      fetch: async () => response({ ret: 0 }),
      productVersion: "0.1.0",
    });
    await expect(
      client.send({
        ...textRequest(),
        secret: { ...textRequest().secret, contextToken: null },
      }),
    ).resolves.toEqual({
      status: "failed",
      code: "INVALID_SEND_INPUT",
    });

    const malformed = new IlinkClient({
      fetch: async () => response({ ret: "bad" }),
      productVersion: "0.1.0",
    });
    await expect(malformed.send(textRequest())).resolves.toEqual({
      status: "unknown",
      code: "MALFORMED_SEND_RESPONSE",
    });
    const httpFailure = new IlinkClient({
      fetch: async () => response({}, 503),
      productVersion: "0.1.0",
    });
    await expect(httpFailure.send(textRequest())).resolves.toEqual({
      status: "unknown",
      code: "NETWORK_RESULT_UNKNOWN",
    });

    const malformedUpdates = new IlinkClient({
      fetch: async () => response({ ret: "bad" }),
      productVersion: "0.1.0",
    });
    await expect(
      malformedUpdates.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "token",
        cursor: "",
      }),
    ).resolves.toEqual({ status: "retry", code: "MALFORMED_UPDATES_RESPONSE" });
    const retFailure = new IlinkClient({
      fetch: async () => response({ ret: -7 }),
      productVersion: "0.1.0",
    });
    await expect(
      retFailure.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "token",
        cursor: "",
      }),
    ).resolves.toEqual({ status: "retry", code: "ILINK_RET_-7" });
  });

  it("implements the complete QR status state machine and validates URLs", async () => {
    const statuses: unknown[] = [
      { status: "wait" },
      { status: "scaned" },
      { status: "expired" },
      { status: "verify_code_blocked" },
      { status: "binded_redirect" },
      { status: "need_verifycode" },
      { status: "scaned_but_redirect", redirect_host: "login.example.com" },
      {
        status: "confirmed",
        bot_token: "bot",
        ilink_bot_id: "id",
        ilink_user_id: "user",
        baseurl: "https://redirect.example.com/path",
      },
    ];
    const client = new IlinkClient({
      fetch: async () => response(statuses.shift()),
      productVersion: "0.1.0",
    });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({ status: "wait" });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({ status: "scaned" });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({ status: "expired" });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({ status: "verify_code_blocked" });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({ status: "binded_redirect" });
    await expect(
      client.pollQr({
        qrcode: "q",
        baseUrl: "https://ilinkai.weixin.qq.com",
        verifyCode: "1234",
      }),
    ).resolves.toEqual({ status: "need_verifycode" });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toEqual({
      status: "scaned_but_redirect",
      redirectHost: "login.example.com",
    });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "https://ilinkai.weixin.qq.com" }),
    ).resolves.toMatchObject({
      status: "confirmed",
      baseUrl: "https://redirect.example.com/path",
    });

    const incomplete = new IlinkClient({
      fetch: async () => response({ status: "confirmed", bot_token: "bot" }),
      productVersion: "0.1.0",
    });
    await expect(
      incomplete.pollQr({
        qrcode: "q",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_QR_CONFIRMATION" });
    const malformed = new IlinkClient({
      fetch: async () => response({ status: 1 }),
      productVersion: "0.1.0",
    });
    await expect(
      malformed.pollQr({
        qrcode: "q",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_QR_STATUS" });
    await expect(
      client.pollQr({ qrcode: "q", baseUrl: "http://unsafe.example.com" }),
    ).rejects.toMatchObject({ code: "INVALID_BASE_URL" });
  });

  it("handles QR creation, aborts, normal timeout variants, and lifecycle notification failures", async () => {
    const created = new IlinkClient({
      fetch: async () =>
        response({ qrcode: "q", qrcode_img_content: "content" }),
      productVersion: "0.1.0",
    });
    await expect(created.createQr(["a", "b"])).resolves.toEqual({
      qrcode: "q",
      qrContent: "content",
    });
    const malformed = new IlinkClient({
      fetch: async () => response({ qrcode: "q" }),
      productVersion: "0.1.0",
    });
    await expect(malformed.createQr([])).rejects.toMatchObject({
      code: "MALFORMED_QR_RESPONSE",
    });

    const aborted = new AbortController();
    aborted.abort();
    const abortClient = new IlinkClient({
      fetch: async () => {
        throw new Error("aborted");
      },
      productVersion: "0.1.0",
    });
    await expect(
      abortClient.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "token",
        cursor: "",
        signal: aborted.signal,
      }),
    ).resolves.toEqual({ status: "retry", code: "ABORTED" });
    const abortError = new IlinkClient({
      fetch: async () => {
        throw new DOMException("timed out", "AbortError");
      },
      productVersion: "0.1.0",
    });
    await expect(
      abortError.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "token",
        cursor: "",
      }),
    ).resolves.toMatchObject({ status: "ok", cursor: "" });

    let slept = false;
    const lifecycle = new IlinkClient({
      fetch: async () => {
        throw new Error("offline");
      },
      sleep: async () => {
        slept = true;
      },
      productVersion: "0.1.0",
    });
    await lifecycle.notifyLifecycle({
      type: "start",
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "token",
    });
    expect(slept).toBe(true);
  });

  it("sends the pinned text protocol and validates business success", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IlinkClient({
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response({ ret: 0 });
      },
      randomBytes: () => Buffer.from([0, 0, 0, 42]),
      sleep: async () => {},
      productVersion: "0.1.0",
    });

    const result = await client.send(textRequest());

    expect(result).toEqual({
      status: "accepted",
      clientMessageId: "client-id",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer bot-token");
    expect(headers.get("authorizationtype")).toBe("ilink_bot_token");
    expect(headers.get("ilink-app-id")).toBe("bot");
    expect(headers.get("ilink-app-clientversion")).toBe("132102");
    expect(headers.get("x-wechat-uin")).toBe("NDI=");

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "user-id",
        client_id: "client-id",
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: "hello" } }],
        context_token: "context-token",
      },
      base_info: {
        channel_version: "2.4.6",
        bot_agent: "send-wechat/0.1.0",
      },
    });
  });

  it("separates server rejection from an unknown network result", async () => {
    const rejected = new IlinkClient({
      fetch: async () => response({ ret: -2, errmsg: "do not expose me" }),
      randomBytes: () => Buffer.alloc(4),
      sleep: async () => {},
      productVersion: "0.1.0",
    });
    await expect(rejected.send(textRequest())).resolves.toEqual({
      status: "rejected",
      code: "ILINK_RET_-2",
    });

    const unknown = new IlinkClient({
      fetch: async () => {
        throw new TypeError("socket closed with sensitive URL");
      },
      randomBytes: () => Buffer.alloc(4),
      sleep: async () => {},
      productVersion: "0.1.0",
    });
    await expect(unknown.send(textRequest())).resolves.toEqual({
      status: "unknown",
      code: "NETWORK_RESULT_UNKNOWN",
    });
  });

  it("polls updates with the cursor and classifies stale authentication", async () => {
    const requests: unknown[] = [];
    const client = new IlinkClient({
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return response({
          ret: 0,
          get_updates_buf: "next-cursor",
          longpolling_timeout_ms: 27000,
          msgs: [
            {
              message_type: 1,
              from_user_id: "user-id",
              context_token: "new-context",
              create_time_ms: 1787558400000,
              item_list: [{ type: 1, text_item: { text: "must be ignored" } }],
            },
          ],
        });
      },
      randomBytes: () => Buffer.alloc(4),
      sleep: async () => {},
      productVersion: "0.1.0",
    });

    const result = await client.pollUpdates({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "bot-token",
      cursor: "cursor",
    });
    expect(result).toEqual({
      status: "ok",
      cursor: "next-cursor",
      suggestedTimeoutMs: 27000,
      inbound: [
        {
          messageType: 1,
          fromUserId: "user-id",
          contextToken: "new-context",
          createTimeMs: 1787558400000,
        },
      ],
    });
    expect(requests).toEqual([
      {
        get_updates_buf: "cursor",
        base_info: {
          channel_version: "2.4.6",
          bot_agent: "send-wechat/0.1.0",
        },
      },
    ]);

    const stale = new IlinkClient({
      fetch: async () => response({ ret: -14, errcode: -14 }),
      randomBytes: () => Buffer.alloc(4),
      sleep: async () => {},
      productVersion: "0.1.0",
    });
    await expect(
      stale.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-token",
        cursor: "",
      }),
    ).resolves.toEqual({ status: "auth_stale" });

    const explicitError = new IlinkClient({
      fetch: async () => response({ errcode: -2, errmsg: "server error" }),
      productVersion: "0.1.0",
    });
    await expect(
      explicitError.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-token",
        cursor: "",
      }),
    ).resolves.toEqual({ status: "retry", code: "ILINK_ERR_-2" });
  });

  it("treats a normal long-poll timeout as empty success and never erases a cursor", async () => {
    const timeoutClient = new IlinkClient({
      productVersion: "0.1.0",
      fetch: async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
    });
    await expect(
      timeoutClient.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-token",
        cursor: "durable-cursor",
      }),
    ).resolves.toEqual({
      status: "ok",
      cursor: "durable-cursor",
      suggestedTimeoutMs: 35_000,
      inbound: [],
    });

    const emptyCursorClient = new IlinkClient({
      productVersion: "0.1.0",
      fetch: async () => response({ ret: 0, get_updates_buf: "", msgs: [] }),
    });
    await expect(
      emptyCursorClient.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-token",
        cursor: "durable-cursor",
      }),
    ).resolves.toMatchObject({ status: "ok", cursor: "durable-cursor" });
  });

  it("accepts the upstream empty update shape when optional result codes are omitted", async () => {
    const client = new IlinkClient({
      productVersion: "0.1.0",
      fetch: async () =>
        response({
          msgs: [],
          sync_buf: "deprecated-cursor",
          get_updates_buf: "next-cursor",
        }),
    });

    await expect(
      client.pollUpdates({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botToken: "bot-token",
        cursor: "",
      }),
    ).resolves.toEqual({
      status: "ok",
      cursor: "next-cursor",
      suggestedTimeoutMs: 35_000,
      inbound: [],
    });
  });

  it("fails closed on an unknown QR state", async () => {
    const client = new IlinkClient({
      fetch: async () => response({ status: "surprise" }),
      randomBytes: () => Buffer.alloc(4),
      sleep: async () => {},
      productVersion: "0.1.0",
    });

    await expect(
      client.pollQr({
        qrcode: "temporary-qr",
        baseUrl: "https://ilinkai.weixin.qq.com",
      }),
    ).rejects.toBeInstanceOf(IlinkProtocolError);
  });

  it("rejects oversized protocol responses before reading their body", async () => {
    const client = new IlinkClient({
      fetch: async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(4 * 1024 * 1024 + 1) },
        }),
      productVersion: "0.1.0",
    });

    await expect(client.createQr([])).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("paces consecutive sendmessage requests by at least two seconds", async () => {
    let now = 10_000;
    const sleeps: number[] = [];
    const client = new IlinkClient({
      fetch: async () => response({ ret: 0 }),
      randomBytes: () => Buffer.alloc(4),
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      productVersion: "0.1.0",
    });

    await client.send(textRequest());
    await client.send({ ...textRequest(), clientId: "client-id-2" });

    expect(sleeps).toEqual([2000]);
  });
});
