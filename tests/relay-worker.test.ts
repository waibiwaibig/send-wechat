/// <reference types="@cloudflare/vitest-plugin/types" />

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("personal relay Worker", () => {
  it("exposes only a metadata-free health check", async () => {
    const response = await SELF.fetch("https://relay.test/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      service: "send-wechat-personal-relay",
      version: 1,
    });
  });

  it("fails immediately without persisting a request when the Hub is offline", async () => {
    const first = await SELF.fetch("https://relay.test/v1/request", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-send-wechat-request-id": "request-1",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    const second = await SELF.fetch("https://relay.test/v1/request", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-send-wechat-request-id": "request-1",
      },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      ok: false,
      error: { code: "HUB_OFFLINE", retryable: true },
    });
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({
      ok: false,
      error: { code: "HUB_OFFLINE", retryable: true },
    });
  });

  it("authenticates one Hub and forwards opaque request and response bytes", async () => {
    const unauthorized = await SELF.fetch("https://relay.test/v1/hub", {
      headers: { Upgrade: "websocket" },
    });
    expect(unauthorized.status).toBe(401);

    const connected = await SELF.fetch("https://relay.test/v1/hub", {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer test-hub-auth-token",
      },
    });
    expect(connected.status).toBe(101);
    const hub = connected.webSocket;
    expect(hub).not.toBeNull();
    hub?.accept();

    const forwarded = new Promise<string>((resolve) => {
      hub?.addEventListener("message", (event) => resolve(String(event.data)), {
        once: true,
      });
    });
    const clientResponse = SELF.fetch("https://relay.test/v1/request", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-send-wechat-request-id": "request-2",
      },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(JSON.parse(await forwarded)).toEqual({
      v: 1,
      type: "request",
      requestId: "request-2",
      payload: "AQID",
    });
    hub?.send(
      JSON.stringify({
        v: 1,
        type: "response",
        requestId: "request-2",
        payload: "BAU",
      }),
    );

    const response = await clientResponse;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([4, 5]),
    );
    hub?.close(1000, "done");
  });

  it("returns a Hub protocol rejection immediately instead of waiting for timeout", async () => {
    const connected = await SELF.fetch("https://relay.test/v1/hub", {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer test-hub-auth-token",
      },
    });
    const hub = connected.webSocket;
    hub?.accept();
    const forwarded = new Promise<string>((resolve) => {
      hub?.addEventListener("message", (event) => resolve(String(event.data)), {
        once: true,
      });
    });
    const clientResponse = SELF.fetch("https://relay.test/v1/request", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-send-wechat-request-id": "request-error",
      },
      body: new Uint8Array([1]),
    });
    expect(JSON.parse(await forwarded).requestId).toBe("request-error");
    hub?.send(
      JSON.stringify({
        v: 1,
        type: "error",
        requestId: "request-error",
        error: { code: "PAIRING_AUTH_FAILED", retryable: false },
      }),
    );
    const response = await clientResponse;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "PAIRING_AUTH_FAILED", retryable: false },
    });
    hub?.close(1000, "done");
  });
});
