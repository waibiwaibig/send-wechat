import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createProxyAwareFetch } from "../src/platform/network.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("platform network adapter", () => {
  it("routes an outbound request through an OS-resolved HTTP proxy without proxy environment variables", async () => {
    let requestedUrl = "";
    const proxy = createServer((request, response) => {
      requestedUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"via":"proxy"}');
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    closeCallbacks.push(
      async () =>
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        ),
    );
    const address = proxy.address();
    if (address === null || typeof address === "string")
      throw new Error("TEST_PROXY_ADDRESS_INVALID");
    const reportedFailures: unknown[] = [];
    const fetchThroughProxy = createProxyAwareFetch({
      resolve: async () => [
        { kind: "http", host: `127.0.0.1:${address.port}` },
      ],
      reportProxyFailed(proxy) {
        reportedFailures.push(proxy);
      },
    });

    const response = await fetchThroughProxy(
      "http://send-wechat-target.invalid/v1/health",
    );

    await expect(response.json()).resolves.toEqual({ via: "proxy" });
    expect(requestedUrl).toBe("http://send-wechat-target.invalid/v1/health");
    expect(reportedFailures).toEqual([]);
  });

  it("reports a failed proxy and falls back to the next resolved route", async () => {
    const unavailableProxy = createServer();
    const unavailablePort = await listen(unavailableProxy);
    await close(unavailableProxy);

    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"via":"direct"}');
    });
    const targetPort = await listen(target);
    closeCallbacks.push(async () => await close(target));
    const failedProxy = {
      kind: "http" as const,
      host: `127.0.0.1:${unavailablePort}`,
    };
    const reportedFailures: unknown[] = [];
    const networkFetch = createProxyAwareFetch({
      resolve: async () => [failedProxy, { kind: "direct" }],
      reportProxyFailed(proxy) {
        reportedFailures.push(proxy);
      },
    });

    const response = await networkFetch(
      `http://127.0.0.1:${targetPort}/v1/health`,
    );

    await expect(response.json()).resolves.toEqual({ via: "direct" });
    expect(reportedFailures).toEqual([failedProxy]);
  });

  it("fails closed when the OS resolver returns no usable route", async () => {
    const noRoute = createProxyAwareFetch({
      resolve: async () => [],
      reportProxyFailed() {},
    });
    await expect(noRoute("https://example.invalid")).rejects.toThrow(
      "SYSTEM_PROXY_ROUTE_MISSING",
    );

    const invalidRoute = createProxyAwareFetch({
      resolve: async () => [{ kind: "http" }],
      reportProxyFailed() {},
    });
    await expect(invalidRoute("https://example.invalid")).rejects.toThrow(
      "SYSTEM_PROXY_ROUTE_INVALID",
    );
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("TEST_SERVER_ADDRESS_INVALID");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
