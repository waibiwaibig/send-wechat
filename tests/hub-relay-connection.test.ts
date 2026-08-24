import { describe, expect, it } from "vitest";

import {
  HubRelayConnection,
  type RelayForwardedRequest,
} from "../src/relay/hub-connection.js";
import {
  HubRelayConnector,
  type HubRelaySocket,
} from "../src/relay/hub-connector.js";
import { RelayProtocolError } from "../src/relay/protocol.js";

describe("Hub relay WebSocket message connection", () => {
  it("decodes one forwarded frame and returns the processor response", async () => {
    const connection = new HubRelayConnection({
      process: async (frame) => {
        expect(frame).toEqual(Buffer.from([1, 2, 3]));
        return Buffer.from([4, 5]);
      },
    });
    const request: RelayForwardedRequest = {
      v: 1,
      type: "request",
      requestId: "request-1",
      payload: Buffer.from([1, 2, 3]).toString("base64url"),
    };

    await expect(connection.respond(JSON.stringify(request))).resolves.toBe(
      JSON.stringify({
        v: 1,
        type: "response",
        requestId: "request-1",
        payload: Buffer.from([4, 5]).toString("base64url"),
      }),
    );
  });

  it("returns a bounded public error without leaking exception messages", async () => {
    const connection = new HubRelayConnection({
      process: async () => {
        throw new RelayProtocolError("RELAY_DEVICE_UNKNOWN");
      },
    });
    const request = JSON.stringify({
      v: 1,
      type: "request",
      requestId: "request-2",
      payload: "AQID",
    });

    await expect(connection.respond(request)).resolves.toBe(
      JSON.stringify({
        v: 1,
        type: "error",
        requestId: "request-2",
        error: { code: "RELAY_DEVICE_UNKNOWN", retryable: false },
      }),
    );
    await expect(connection.respond("private invalid input")).rejects.toThrow(
      /RELAY_FORWARD_INVALID/,
    );
  });

  it("normalizes malformed frames and unexpected processor failures", async () => {
    const invalidResponse = new HubRelayConnection({
      process: async () => Buffer.alloc(0),
    });
    const request = JSON.stringify({
      v: 1,
      type: "request",
      requestId: "request-4",
      payload: "AQ",
    });
    expect(JSON.parse(await invalidResponse.respond(request))).toMatchObject({
      type: "error",
      error: { code: "RELAY_RESPONSE_INVALID", retryable: false },
    });

    const unexpected = new HubRelayConnection({
      process: async () => {
        throw new Error("private failure");
      },
    });
    expect(JSON.parse(await unexpected.respond(request))).toMatchObject({
      type: "error",
      error: { code: "RELAY_PROCESSING_FAILED", retryable: false },
    });
    const unsafeCode = new HubRelayConnection({
      process: async () => {
        throw new RelayProtocolError("private code", true);
      },
    });
    expect(JSON.parse(await unsafeCode.respond(request))).toMatchObject({
      type: "error",
      error: { code: "RELAY_PROCESSING_FAILED", retryable: true },
    });
    await expect(
      unexpected.respond(
        JSON.stringify({
          v: 1,
          type: "request",
          requestId: "request-5",
          payload: "A",
        }),
      ),
    ).rejects.toThrow(/RELAY_FORWARD_INVALID/);
    await expect(unexpected.respond(JSON.stringify({ v: 2 }))).rejects.toThrow(
      /RELAY_FORWARD_INVALID/,
    );
  });

  it("keeps the Hub token out of the URL and sends processed responses", async () => {
    const listeners: {
      open?: () => void;
      message?: (message: string) => void;
      close?: () => void;
      error?: () => void;
    } = {};
    const sent: string[] = [];
    const socket: HubRelaySocket = {
      onOpen(listener) {
        listeners.open = listener;
      },
      onMessage(listener) {
        listeners.message = listener;
      },
      onClose(listener) {
        listeners.close = listener;
      },
      onError(listener) {
        listeners.error = listener;
      },
      send(message) {
        sent.push(message);
      },
      close() {
        listeners.close?.();
      },
    };
    const connections: Array<{ url: string; token: string }> = [];
    const connector = new HubRelayConnector({
      relayUrl: "https://alice.workers.dev",
      hubAuthToken: "private-hub-token",
      connection: new HubRelayConnection({
        process: async () => Buffer.from([9]),
      }),
      socketFactory: {
        connect(url, token) {
          connections.push({ url, token });
          return socket;
        },
      },
      sleep: async () => undefined,
      random: () => 0,
    });
    connector.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.open?.();
    listeners.message?.(
      JSON.stringify({
        v: 1,
        type: "request",
        requestId: "request-3",
        payload: "AQ",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connections).toEqual([
      {
        url: "wss://alice.workers.dev/v1/hub",
        token: "private-hub-token",
      },
    ]);
    expect(connections[0]?.url).not.toContain("private-hub-token");
    expect(JSON.parse(sent[0]!).payload).toBe("CQ");
    await connector.stop();
  });
});
