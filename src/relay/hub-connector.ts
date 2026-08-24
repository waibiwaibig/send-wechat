import WebSocket from "ws";

import { nodeAgentWithSystemProxy } from "../platform/network.js";
import { HubRelayConnection } from "./hub-connection.js";
import { RelayProtocolError } from "./protocol.js";

export type HubRelaySocket = {
  onOpen(listener: () => void): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: () => void): void;
  send(message: string): void;
  close(): void;
};

export type HubRelaySocketFactory = {
  connect(url: string, hubAuthToken: string): HubRelaySocket;
};

export class HubRelayConnector {
  private abortController: AbortController | null = null;
  private task: Promise<void> | null = null;
  private socket: HubRelaySocket | null = null;

  public constructor(
    private readonly options: {
      readonly relayUrl: string;
      readonly hubAuthToken: string;
      readonly connection: HubRelayConnection;
      readonly socketFactory?: HubRelaySocketFactory;
      readonly sleep?: (
        milliseconds: number,
        signal?: AbortSignal,
      ) => Promise<void>;
      readonly random?: () => number;
    },
  ) {}

  public start(): void {
    if (this.task !== null)
      throw new RelayProtocolError("RELAY_CONNECTOR_ALREADY_RUNNING");
    const abortController = new AbortController();
    this.abortController = abortController;
    this.task = this.run(abortController.signal);
  }

  public async stop(): Promise<void> {
    this.abortController?.abort();
    this.socket?.close();
    await this.task;
    this.task = null;
    this.abortController = null;
    this.socket = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const socketFactory = this.options.socketFactory ?? defaultSocketFactory;
    const sleep = this.options.sleep ?? defaultSleep;
    const random = this.options.random ?? Math.random;
    const socketUrl = relayWebSocketUrl(this.options.relayUrl);
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const socket = socketFactory.connect(
          socketUrl,
          this.options.hubAuthToken,
        );
        this.socket = socket;
        await this.runConnection(socket, signal);
        attempt = 0;
      } catch {
        attempt += 1;
      } finally {
        this.socket = null;
      }
      if (signal.aborted) break;
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      await sleep(Math.round(base * (0.75 + random() * 0.5)), signal);
    }
  }

  private async runConnection(
    socket: HubRelaySocket,
    signal: AbortSignal,
  ): Promise<void> {
    let messageTail = Promise.resolve();
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        void messageTail.finally(resolve);
      };
      const abort = (): void => {
        socket.close();
        finish();
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.onOpen(() => undefined);
      socket.onMessage((message) => {
        messageTail = messageTail.then(async () => {
          try {
            socket.send(await this.options.connection.respond(message));
          } catch {
            // Malformed relay messages are ignored without exposing details.
          }
        });
      });
      socket.onClose(finish);
      socket.onError(() => {
        socket.close();
        finish();
      });
      if (signal.aborted) abort();
    });
  }
}

const defaultSocketFactory: HubRelaySocketFactory = {
  connect(url, hubAuthToken) {
    const socket = new WebSocket(url, {
      agent: nodeAgentWithSystemProxy(),
      headers: { Authorization: `Bearer ${hubAuthToken}` },
      handshakeTimeout: 10_000,
      maxPayload: 12 * 1024 * 1024,
      perMessageDeflate: false,
    });
    return {
      onOpen(listener) {
        socket.on("open", listener);
      },
      onMessage(listener) {
        socket.on("message", (data, isBinary) => {
          if (isBinary) return;
          const bytes = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          listener(bytes.toString("utf8"));
        });
      },
      onClose(listener) {
        socket.on("close", listener);
      },
      onError(listener) {
        socket.on("error", listener);
      },
      send(message) {
        socket.send(message);
      },
      close() {
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close(1000, "Hub shutting down");
      },
    };
  },
};

function relayWebSocketUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RelayProtocolError("RELAY_URL_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.endsWith(".workers.dev") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new RelayProtocolError("RELAY_URL_INVALID");
  parsed.protocol = "wss:";
  parsed.pathname = "/v1/hub";
  return parsed.toString();
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
