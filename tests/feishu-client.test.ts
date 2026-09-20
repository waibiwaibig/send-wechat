import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { request as httpsRequest } from "node:https";

import { FeishuClient, type FeishuWebhookPost } from "../src/feishu/client.js";

vi.mock("node:https", () => ({
  request: vi.fn(),
}));

const requestMock = vi.mocked(httpsRequest);

const configuration = {
  webhookUrl:
    "https://open.feishu.cn/open-apis/bot/v2/hook/12345678-1234-1234-1234-1234567890ab",
};

type PostResponse = { statusCode: number; body: Buffer };

function postFor(response: PostResponse) {
  return vi.fn<FeishuWebhookPost>(async (url, body, headers) => {
    void url;
    void body;
    void headers;
    return response;
  });
}

function response(code: unknown): PostResponse {
  return {
    statusCode: 200,
    body: Buffer.from(JSON.stringify({ code })),
  };
}

function fakeHttpsResponse(statusCode: number): EventEmitter & {
  statusCode: number;
  destroy: ReturnType<typeof vi.fn>;
} {
  const result = new EventEmitter() as EventEmitter & {
    statusCode: number;
    destroy: ReturnType<typeof vi.fn>;
  };
  result.statusCode = statusCode;
  result.destroy = vi.fn((error?: Error) => {
    if (error !== undefined)
      process.nextTick(() => result.emit("error", error));
    return result;
  });
  return result;
}

function fakeHttpsRequest(
  statusCode: number,
  body: string | Buffer,
): EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  response?: ReturnType<typeof fakeHttpsResponse>;
} {
  const request = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    response?: ReturnType<typeof fakeHttpsResponse>;
  };
  request.destroy = vi.fn((error?: Error) => {
    if (error !== undefined)
      process.nextTick(() => request.emit("error", error));
    return request;
  });
  request.end = vi.fn(() => {
    const response = fakeHttpsResponse(statusCode);
    request.response = response;
    process.nextTick(() => {
      request.emit("response", response);
      process.nextTick(() => {
        response.emit("data", body);
        response.emit("end");
      });
    });
    return request;
  });
  return request;
}

afterEach(() => {
  requestMock.mockReset();
  vi.useRealTimers();
});

describe("FeishuClient webhook text sender", () => {
  it("posts an unsigned text body and returns the local client id", async () => {
    const post = postFor(response(0));
    const client = new FeishuClient(configuration, { post });

    await expect(
      client.send({ type: "text", text: "hello" }, "client-1"),
    ).resolves.toEqual({
      status: "accepted",
      clientMessageId: "client-1",
    });
    expect(post).toHaveBeenCalledWith(
      configuration.webhookUrl,
      Buffer.from(
        JSON.stringify({ msg_type: "text", content: { text: "hello" } }),
      ),
      expect.objectContaining({
        "content-type": "application/json",
      }),
    );
    const sentBody = post.mock.calls[0]?.[1];
    expect(sentBody?.toString("utf8")).not.toContain("timestamp");
    expect(sentBody?.toString("utf8")).not.toContain("sign");
  });

  it("uses the fixed Feishu signature vector when signing is configured", async () => {
    const post = postFor(response(0));
    const client = new FeishuClient(
      { ...configuration, signingSecret: "secret" },
      { post, now: () => 1_700_000_000_123 },
    );

    await client.send({ type: "text", text: "hello" }, "client-2");

    expect(JSON.parse(post.mock.calls[0]![1].toString("utf8"))).toEqual({
      msg_type: "text",
      content: { text: "hello" },
      timestamp: "1700000000",
      sign: "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=",
    });
  });

  it("rejects media before any network dependency is called", async () => {
    const post = vi.fn();
    const client = new FeishuClient(configuration, { post });

    await expect(
      client.send(
        {
          type: "file",
          stagedPath: "/never-read",
          fileName: "x",
          byteLength: 1,
        },
        "media",
      ),
    ).resolves.toEqual({ status: "rejected", code: "FEISHU_TEXT_ONLY" });
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects empty, Unicode-long, and oversized JSON text", async () => {
    const post = vi.fn();
    const client = new FeishuClient(configuration, { post });

    await expect(
      client.send({ type: "text", text: "" }, "empty"),
    ).resolves.toEqual({ status: "rejected", code: "EMPTY_TEXT" });
    await expect(
      client.send({ type: "text", text: "🙂".repeat(4001) }, "long"),
    ).resolves.toEqual({ status: "rejected", code: "TEXT_TOO_LONG" });
    await expect(
      client.send({ type: "text", text: "\ud800".repeat(4000) }, "json-long"),
    ).resolves.toEqual({ status: "rejected", code: "JSON_TOO_LARGE" });
    expect(post).not.toHaveBeenCalled();
  });

  it("classifies remote rejection, client errors, server errors, malformed success, and network errors", async () => {
    const cases: Array<[PostResponse, { status: string; code: string }]> = [
      [response(230001), { status: "rejected", code: "FEISHU_230001" }],
      [
        { statusCode: 400, body: Buffer.from("private response") },
        { status: "rejected", code: "FEISHU_HTTP_400" },
      ],
      [
        { statusCode: 302, body: Buffer.from("redirect") },
        { status: "rejected", code: "FEISHU_HTTP_302" },
      ],
      [
        { statusCode: 503, body: Buffer.from("private response") },
        { status: "unknown", code: "REMOTE_SERVER_ERROR" },
      ],
      [
        { statusCode: 200, body: Buffer.from("not json") },
        { status: "unknown", code: "MALFORMED_SEND_RESPONSE" },
      ],
    ];
    for (const [remoteResponse, expected] of cases) {
      const post = postFor(remoteResponse);
      const client = new FeishuClient(configuration, { post });
      await expect(
        client.send({ type: "text", text: "hello" }, "case"),
      ).resolves.toEqual(expected);
    }

    const post = vi.fn(async () => {
      throw new Error("secret response text https://private.example");
    });
    const result = await new FeishuClient(
      { ...configuration, signingSecret: "top-secret" },
      { post },
    ).send({ type: "text", text: "hello" }, "network");
    expect(result).toEqual({
      status: "unknown",
      code: "NETWORK_RESULT_UNKNOWN",
    });
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("private.example");
  });

  it("validates configuration locally without sending a request", async () => {
    const post = vi.fn();
    await expect(
      new FeishuClient(configuration, { post }).verify(),
    ).resolves.toBeUndefined();
    await expect(
      new FeishuClient(
        { webhookUrl: "http://insecure.example" },
        { post },
      ).verify(),
    ).rejects.toMatchObject({ code: "FEISHU_CONFIGURATION_INVALID" });
    expect(post).not.toHaveBeenCalled();
  });

  it("uses one non-redirecting HTTPS request with bounded response handling", async () => {
    const request = fakeHttpsRequest(302, "redirect");
    requestMock.mockReturnValueOnce(request as never);
    const rejectedClient = new FeishuClient(configuration);
    await expect(
      rejectedClient.send({ type: "text", text: "hello" }, "redirect"),
    ).resolves.toEqual({ status: "rejected", code: "FEISHU_HTTP_302" });
    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      agent: expect.anything(),
    });
    expect(request.end).toHaveBeenCalledOnce();

    const oversized = fakeHttpsRequest(200, Buffer.alloc(64 * 1024 + 1));
    requestMock.mockReturnValueOnce(oversized as never);
    await expect(
      new FeishuClient(configuration).send(
        { type: "text", text: "hello" },
        "large",
      ),
    ).resolves.toEqual({ status: "unknown", code: "NETWORK_RESULT_UNKNOWN" });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(oversized.response?.destroy).toHaveBeenCalled();
  });

  it("maps a total request timeout to an unknown result", async () => {
    vi.useFakeTimers();
    const request = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    request.end = vi.fn();
    request.destroy = vi.fn();
    requestMock.mockReturnValueOnce(request as never);
    const pending = new FeishuClient(configuration).send(
      { type: "text", text: "hello" },
      "timeout",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({
      status: "unknown",
      code: "NETWORK_TIMEOUT",
    });
    expect(request.destroy).toHaveBeenCalledOnce();
  });
});
