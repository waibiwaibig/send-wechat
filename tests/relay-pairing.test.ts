import { describe, expect, it } from "vitest";

import {
  PairingInvitations,
  parsePairingInvitation,
} from "../src/relay/invitation.js";

describe("personal-relay pairing invitations", () => {
  it("issues one short-lived invitation that can be consumed exactly once", () => {
    let now = Date.parse("2026-08-24T08:00:00.000Z");
    let randomValue = 0;
    const invitations = new PairingInvitations({
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, (randomValue += 1)),
    });

    const encoded = invitations.issue("https://alice.workers.dev");
    const invitation = parsePairingInvitation(encoded);

    expect(invitation).toEqual({
      v: 1,
      relay: "https://alice.workers.dev",
      invitationId: Buffer.alloc(16, 1).toString("base64url"),
      secret: Buffer.alloc(32, 2).toString("base64url"),
      expiresAt: now + 10 * 60 * 1000,
    });
    expect(
      invitations.consume(invitation.invitationId, invitation.secret),
    ).toEqual({ relay: "https://alice.workers.dev" });
    expect(() =>
      invitations.consume(invitation.invitationId, invitation.secret),
    ).toThrowError(
      expect.objectContaining({ code: "PAIRING_INVITATION_USED" }),
    );

    const expiring = parsePairingInvitation(
      invitations.issue("https://alice.workers.dev"),
    );
    now = expiring.expiresAt + 1;
    expect(() =>
      invitations.consume(expiring.invitationId, expiring.secret),
    ).toThrowError(
      expect.objectContaining({ code: "PAIRING_INVITATION_EXPIRED" }),
    );
  });

  it("rejects forged secrets without consuming the real invitation", () => {
    const invitations = new PairingInvitations({
      now: () => 1_800_000_000_000,
      randomBytes: (size) => Buffer.alloc(size, size),
    });
    const invitation = parsePairingInvitation(
      invitations.issue("https://owner.workers.dev"),
    );

    expect(() =>
      invitations.consume(
        invitation.invitationId,
        Buffer.alloc(32, 0).toString("base64url"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PAIRING_INVITATION_INVALID" }),
    );
    expect(
      invitations.consume(invitation.invitationId, invitation.secret),
    ).toEqual({ relay: "https://owner.workers.dev" });
  });
});
