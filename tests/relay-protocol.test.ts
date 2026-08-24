import { describe, expect, it } from "vitest";

import { RelayCipher } from "../src/relay/crypto.js";
import {
  HubRelayProcessor,
  RelayHttpTransport,
  RelayProtocolError,
  RemoteRelayClient,
} from "../src/relay/protocol.js";
import type {
  ClientRelayCredential,
  HubRelayCredential,
  RelayCredential,
} from "../src/storage/relay-credential-store.js";

describe("encrypted remote command protocol", () => {
  it("round-trips status and text commands without exposing their contents to the relay", async () => {
    const device: ClientRelayCredential = {
      schemaVersion: 1,
      role: "client",
      deviceId: Buffer.alloc(16, 1).toString("base64url"),
      deviceKey: Buffer.alloc(32, 2).toString("base64url"),
    };
    const hubCredential: HubRelayCredential = {
      schemaVersion: 1,
      role: "hub",
      hubAuthToken: Buffer.alloc(32, 3).toString("base64url"),
      devices: [
        {
          deviceId: device.deviceId,
          deviceKey: device.deviceKey,
          addedAt: "2026-08-24T08:00:00.000Z",
        },
      ],
    };
    let credential: RelayCredential = hubCredential;
    const commands: unknown[] = [];
    const cipher = new RelayCipher({
      randomBytes: (size) => Buffer.alloc(size, 4),
    });
    const processor = new HubRelayProcessor({
      cipher,
      credentialStore: {
        load: async () => credential,
        save: async (value) => {
          credential = value;
        },
      },
      pairing: { accept: async () => Buffer.from("pair-response") },
      execute: async (command) => {
        commands.push(command);
        return { ok: true, command: command.command, private: "result" };
      },
    });
    const requestBodies: Buffer[] = [];
    const fetchImplementation: typeof fetch = async (_url, init) => {
      const requestBody = Buffer.from(
        await new Response(init?.body).arrayBuffer(),
      );
      requestBodies.push(requestBody);
      const responseBody = await processor.process(requestBody);
      return new Response(new Uint8Array(responseBody), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    let requestNumber = 0;
    const client = new RemoteRelayClient({
      relayUrl: "https://alice.workers.dev",
      credential: device,
      cipher,
      transport: new RelayHttpTransport({
        fetch: fetchImplementation,
        requestId: () => `relay-${(requestNumber += 1)}`,
      }),
    });

    await expect(client.execute({ command: "status" })).resolves.toEqual({
      ok: true,
      command: "status",
      private: "result",
    });
    await expect(
      client.execute({
        command: "send_text",
        idempotencyKey: "message-1",
        text: "secret hello",
      }),
    ).resolves.toEqual({
      ok: true,
      command: "send_text",
      private: "result",
    });
    expect(commands).toEqual([
      { command: "status" },
      {
        command: "send_text",
        idempotencyKey: "message-1",
        text: "secret hello",
      },
    ]);
    expect(Buffer.concat(requestBodies).toString("utf8")).not.toContain(
      "secret hello",
    );
  });

  it("maps relay failures and rejects responses encrypted for another device", async () => {
    const credential: ClientRelayCredential = {
      schemaVersion: 1,
      role: "client",
      deviceId: Buffer.alloc(16, 5).toString("base64url"),
      deviceKey: Buffer.alloc(32, 6).toString("base64url"),
    };
    const offline = new RelayHttpTransport({
      requestId: () => "request-1",
      fetch: async () =>
        Response.json(
          { ok: false, error: { code: "HUB_OFFLINE", retryable: true } },
          { status: 503 },
        ),
    });
    await expect(
      offline.exchange("https://alice.workers.dev", Buffer.from("frame")),
    ).rejects.toMatchObject({ code: "HUB_OFFLINE", retryable: true });

    const wrongCiphertext = new RelayCipher({
      randomBytes: (size) => Buffer.alloc(size, 7),
    }).seal({
      kind: "device",
      credentialId: credential.deviceId,
      key: Buffer.alloc(32, 8),
      plaintext: Buffer.from(
        JSON.stringify({
          v: 1,
          type: "command_result",
          requestId: "request-2",
          body: { ok: true },
        }),
      ),
    });
    const client = new RemoteRelayClient({
      relayUrl: "https://alice.workers.dev",
      credential,
      transport: {
        exchange: async () => ({
          requestId: "request-2",
          frame: wrongCiphertext,
        }),
      },
    });
    await expect(client.execute({ command: "status" })).rejects.toBeInstanceOf(
      RelayProtocolError,
    );
  });
});
