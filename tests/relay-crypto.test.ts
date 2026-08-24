import { describe, expect, it } from "vitest";

import { RelayCipher } from "../src/relay/crypto.js";

describe("personal-relay encrypted frames", () => {
  it("round-trips opaque bytes only for the intended credential scope", () => {
    const key = Buffer.alloc(32, 0x11);
    const cipher = new RelayCipher({
      randomBytes: (size) => Buffer.alloc(size, 0x22),
    });
    const plaintext = Buffer.from(
      JSON.stringify({ command: "send_text", text: "private hello" }),
      "utf8",
    );

    const encrypted = cipher.seal({
      kind: "device",
      credentialId: "device-1",
      key,
      plaintext,
    });

    expect(encrypted.toString("utf8")).not.toContain("private hello");
    expect(cipher.header(encrypted)).toEqual({
      kind: "device",
      credentialId: "device-1",
    });
    expect(
      cipher.open({
        frame: encrypted,
        expectedKind: "device",
        expectedCredentialId: "device-1",
        key,
      }),
    ).toEqual(plaintext);
    expect(() =>
      cipher.open({
        frame: encrypted,
        expectedKind: "device",
        expectedCredentialId: "device-2",
        key,
      }),
    ).toThrowError(expect.objectContaining({ code: "RELAY_FRAME_INVALID" }));
  });

  it("rejects tampering and the wrong key before returning plaintext", () => {
    const cipher = new RelayCipher({
      randomBytes: (size) => Buffer.alloc(size, 0x33),
    });
    const key = Buffer.alloc(32, 0x44);
    const encrypted = cipher.seal({
      kind: "pair",
      credentialId: "invite-1",
      key,
      plaintext: Buffer.from("pair me"),
    });
    const frame = JSON.parse(encrypted.toString("utf8")) as {
      ciphertext: string;
    };
    frame.ciphertext = `${frame.ciphertext.slice(0, -1)}A`;

    expect(() =>
      cipher.open({
        frame: Buffer.from(JSON.stringify(frame)),
        expectedKind: "pair",
        expectedCredentialId: "invite-1",
        key,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RELAY_FRAME_AUTH_FAILED" }),
    );
    expect(() =>
      cipher.open({
        frame: encrypted,
        expectedKind: "pair",
        expectedCredentialId: "invite-1",
        key: Buffer.alloc(32, 0x45),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RELAY_FRAME_AUTH_FAILED" }),
    );
  });
});
