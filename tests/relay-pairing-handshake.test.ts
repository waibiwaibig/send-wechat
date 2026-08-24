import { describe, expect, it } from "vitest";

import { RelayCipher } from "../src/relay/crypto.js";
import {
  PairingClient,
  PairingHub,
  PairingProtocolError,
} from "../src/relay/pairing.js";
import {
  PairingInvitations,
  parsePairingInvitation,
} from "../src/relay/invitation.js";
import type {
  HubRelayCredential,
  RelayCredential,
} from "../src/storage/relay-credential-store.js";

describe("end-to-end personal-relay pairing", () => {
  it("adds one remote device only after an authenticated, encrypted handshake", async () => {
    const now = Date.parse("2026-08-24T08:00:00.000Z");
    let invitationRandom = 0;
    const invitations = new PairingInvitations({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, (invitationRandom += 1)),
    });
    const encodedInvitation = invitations.issue("https://alice.workers.dev");
    let hubCredential: HubRelayCredential = {
      schemaVersion: 1,
      role: "hub",
      hubAuthToken: Buffer.alloc(32, 0x10).toString("base64url"),
      devices: [],
    };
    const credentialStore = {
      load: async (): Promise<RelayCredential> => hubCredential,
      save: async (credential: RelayCredential) => {
        if (credential.role !== "hub") throw new Error("wrong role");
        hubCredential = credential;
      },
    };
    const cipher = new RelayCipher({
      randomBytes: (size) => Buffer.alloc(size, 0x20),
    });
    let clientRandom = 0x30;
    const client = new PairingClient({
      now: () => now,
      cipher,
      randomBytes: (size) => Buffer.alloc(size, (clientRandom += 1)),
    });
    const hub = new PairingHub({
      invitations,
      credentialStore,
      cipher,
      now: () => now,
    });

    const attempt = client.begin(encodedInvitation);
    expect(attempt.relayUrl).toBe("https://alice.workers.dev");
    expect(attempt.requestFrame.toString("utf8")).not.toContain(
      attempt.credential.deviceKey,
    );

    const responseFrame = await hub.accept(attempt.requestFrame);
    expect(client.complete(attempt, responseFrame)).toEqual(attempt.credential);
    expect(hubCredential.devices).toEqual([
      {
        deviceId: attempt.credential.deviceId,
        deviceKey: attempt.credential.deviceKey,
        addedAt: "2026-08-24T08:00:00.000Z",
      },
    ]);

    await expect(hub.accept(attempt.requestFrame)).resolves.toEqual(
      responseFrame,
    );
    expect(hubCredential.devices).toHaveLength(1);
  });

  it("does not consume an invitation for a forged frame and rejects expiry", async () => {
    let now = Date.parse("2026-08-24T08:00:00.000Z");
    let invitationRandom = 0;
    const invitations = new PairingInvitations({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, (invitationRandom += 1)),
    });
    const encodedInvitation = invitations.issue("https://bob.workers.dev");
    const parsed = parsePairingInvitation(encodedInvitation);
    const credential: HubRelayCredential = {
      schemaVersion: 1,
      role: "hub",
      hubAuthToken: Buffer.alloc(32, 0x40).toString("base64url"),
      devices: [],
    };
    const store = {
      load: async (): Promise<RelayCredential> => credential,
      save: async () => undefined,
    };
    const cipher = new RelayCipher({
      randomBytes: (size) => Buffer.alloc(size, 0x50),
    });
    const hub = new PairingHub({
      invitations,
      credentialStore: store,
      cipher,
      now: () => now,
    });
    const forged = cipher.seal({
      kind: "pair",
      credentialId: parsed.invitationId,
      key: Buffer.alloc(32, 0x99),
      plaintext: Buffer.from("forged"),
    });
    await expect(hub.accept(forged)).rejects.toMatchObject({
      code: "PAIRING_AUTH_FAILED",
    });

    const client = new PairingClient({
      now: () => now,
      cipher,
      randomBytes: (size) => Buffer.alloc(size, size),
    });
    const valid = client.begin(encodedInvitation);
    await expect(hub.accept(valid.requestFrame)).resolves.toBeInstanceOf(
      Buffer,
    );

    const expiring = invitations.issue("https://bob.workers.dev");
    now += 10 * 60 * 1000 + 1;
    expect(() => client.begin(expiring)).toThrowError(
      expect.objectContaining({ code: "PAIRING_INVITATION_EXPIRED" }),
    );
  });

  it("rejects a response that is not an authenticated acknowledgement", () => {
    const now = Date.parse("2026-08-24T08:00:00.000Z");
    let random = 0;
    const invitations = new PairingInvitations({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, (random += 1)),
    });
    const client = new PairingClient({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, size),
    });
    const attempt = client.begin(
      invitations.issue("https://carol.workers.dev"),
    );
    expect(() => client.complete(attempt, Buffer.from("{}"))).toThrowError(
      expect.objectContaining({ code: "PAIRING_RESPONSE_INVALID" }),
    );
    expect(PairingProtocolError).toBeDefined();
  });
});
