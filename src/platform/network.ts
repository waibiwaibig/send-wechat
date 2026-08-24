import type { Agent as NodeHttpAgent } from "node:http";

import {
  ProxyResolver,
  type Proxy as ResolvedProxy,
} from "@vscode/os-proxy-resolver";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import {
  ProxyAgent as UndiciProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";

export type PlatformFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SystemProxyResolver = {
  resolve(url: string): Promise<ResolvedProxy[]>;
  reportProxyFailed(proxy: ResolvedProxy): void;
};

const systemProxyResolver = new ProxyResolver();
const dispatchers = new Map<string, Dispatcher>();

export function createProxyAwareFetch(
  resolver: SystemProxyResolver = systemProxyResolver,
): PlatformFetch {
  return async (input, init) => {
    const url = input.toString();
    const routes = await resolver.resolve(url);
    if (routes.length === 0) throw new Error("SYSTEM_PROXY_ROUTE_MISSING");

    let lastError: Error | undefined;
    for (const route of routes) {
      try {
        const dispatcher = dispatcherFor(route);
        return (await undiciFetch(url, {
          ...(init as Parameters<typeof undiciFetch>[1]),
          ...(dispatcher === undefined ? {} : { dispatcher }),
        })) as unknown as Response;
      } catch (error) {
        if (init?.signal?.aborted === true) throw error;
        resolver.reportProxyFailed(route);
        lastError =
          error instanceof Error
            ? error
            : new Error("SYSTEM_PROXY_CONNECTION_FAILED");
      }
    }
    throw lastError ?? new Error("SYSTEM_PROXY_CONNECTION_FAILED");
  };
}

const systemFetch = createProxyAwareFetch();
const systemNodeAgent = new NodeProxyAgent({
  getProxyForUrl: async (url) => {
    const routes = await systemProxyResolver.resolve(url);
    if (routes.length === 0) throw new Error("SYSTEM_PROXY_ROUTE_MISSING");
    return proxyUrl(routes[0]!);
  },
});

export const fetchWithSystemProxy: PlatformFetch = async (input, init) =>
  await systemFetch(input, init);

export function nodeAgentWithSystemProxy(): NodeHttpAgent {
  return systemNodeAgent;
}

function dispatcherFor(route: ResolvedProxy): Dispatcher | undefined {
  const url = proxyUrl(route);
  if (url === "") return undefined;
  const existing = dispatchers.get(url);
  if (existing !== undefined) return existing;
  const dispatcher = new UndiciProxyAgent(url);
  dispatchers.set(url, dispatcher);
  return dispatcher;
}

function proxyUrl(route: ResolvedProxy): string {
  if (route.kind === "direct") return "";
  if (route.host === undefined || route.host.trim() === "")
    throw new Error("SYSTEM_PROXY_ROUTE_INVALID");
  const raw = route.host.includes("://")
    ? route.host
    : `${route.kind === "socks" ? "socks5" : "http"}://${route.host}`;
  const parsed = new URL(raw);
  const protocols =
    route.kind === "socks" ? ["socks:", "socks5:"] : ["http:", "https:"];
  if (
    !protocols.includes(parsed.protocol) ||
    parsed.hostname === "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new Error("SYSTEM_PROXY_ROUTE_INVALID");
  return parsed.toString();
}
