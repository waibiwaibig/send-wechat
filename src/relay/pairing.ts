import { randomBytes as nodeRandomBytes } from "node:crypto";

import { z } from "zod";

import { RelayCipher, RelayFrameError } from "./crypto.js";
import {
  PairingInvitationError,
  PairingInvitations,
  parsePairingInvitation,
} from "./invitation.js";
import type {
  ClientRelayCredential,
  RelayCredential,
} from "../storage/relay-credential-store.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const pairingRequestSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("pair_request"),
    deviceId: z.string().length(22).regex(BASE64URL),
    deviceKey: z.string().length(43).regex(BASE64URL),
  })
  .strict();
const pairingResponseSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("pair_accepted"),
    deviceId: z.string().length(22).regex(BASE64URL),
  })
  .strict();

export type PairingAttempt = {
  readonly relayUrl: string;
  readonly invitationId: string;
  readonly credential: ClientRelayCredential;
  readonly requestFrame: Buffer;
  readonly invitationSecret: Buffer;
};

export type RelayCredentialStorePort = {
  load(): Promise<RelayCredential | null>;
  save(credential: RelayCredential): Promise<void>;
};

export class PairingProtocolError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "PairingProtocolError";
  }
}

export class PairingClient {
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly cipher: RelayCipher;

  public constructor(
    dependencies: {
      now?: () => number;
      randomBytes?: (size: number) => Buffer;
      cipher?: RelayCipher;
    } = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
    this.cipher = dependencies.cipher ?? new RelayCipher();
  }

  public begin(encodedInvitation: string): PairingAttempt {
    const invitation = parsePairingInvitation(encodedInvitation);
    if (this.now() > invitation.expiresAt)
      throw new PairingInvitationError("PAIRING_INVITATION_EXPIRED");
    const deviceIdBytes = this.randomBytes(16);
    const deviceKey = this.randomBytes(32);
    if (deviceIdBytes.byteLength !== 16 || deviceKey.byteLength !== 32)
      throw new PairingProtocolError("PAIRING_REQUEST_INVALID");
    const credential: ClientRelayCredential = {
      schemaVersion: 1,
      role: "client",
      deviceId: deviceIdBytes.toString("base64url"),
      deviceKey: deviceKey.toString("base64url"),
    };
    const invitationSecret = decodeKey(invitation.secret);
    const requestFrame = this.cipher.seal({
      kind: "pair",
      credentialId: invitation.invitationId,
      key: invitationSecret,
      plaintext: Buffer.from(
        JSON.stringify({
          v: 1,
          type: "pair_request",
          deviceId: credential.deviceId,
          deviceKey: credential.deviceKey,
        }),
        "utf8",
      ),
    });
    return {
      relayUrl: invitation.relay,
      invitationId: invitation.invitationId,
      credential,
      requestFrame,
      invitationSecret,
    };
  }

  public complete(
    attempt: PairingAttempt,
    responseFrame: Buffer,
  ): ClientRelayCredential {
    let plaintext: Buffer;
    try {
      plaintext = this.cipher.open({
        frame: responseFrame,
        expectedKind: "pair",
        expectedCredentialId: attempt.invitationId,
        key: attempt.invitationSecret,
      });
    } catch {
      throw new PairingProtocolError("PAIRING_RESPONSE_INVALID");
    }
    const response = parseJson(pairingResponseSchema, plaintext);
    if (response === null || response.deviceId !== attempt.credential.deviceId)
      throw new PairingProtocolError("PAIRING_RESPONSE_INVALID");
    return attempt.credential;
  }
}

export class PairingHub {
  private readonly now: () => number;

  public constructor(
    private readonly dependencies: {
      invitations: PairingInvitations;
      credentialStore: RelayCredentialStorePort;
      cipher: RelayCipher;
      now?: () => number;
    },
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  public async accept(requestFrame: Buffer): Promise<Buffer> {
    let header: { kind: "pair" | "device"; credentialId: string };
    try {
      header = this.dependencies.cipher.header(requestFrame);
    } catch {
      throw new PairingProtocolError("PAIRING_REQUEST_INVALID");
    }
    if (header.kind !== "pair")
      throw new PairingProtocolError("PAIRING_REQUEST_INVALID");

    return this.dependencies.invitations.accept(
      header.credentialId,
      requestFrame,
      async (secret) => {
        let plaintext: Buffer;
        try {
          plaintext = this.dependencies.cipher.open({
            frame: requestFrame,
            expectedKind: "pair",
            expectedCredentialId: header.credentialId,
            key: secret,
          });
        } catch (error) {
          if (
            error instanceof RelayFrameError &&
            error.code === "RELAY_FRAME_AUTH_FAILED"
          )
            throw new PairingProtocolError("PAIRING_AUTH_FAILED");
          throw new PairingProtocolError("PAIRING_REQUEST_INVALID");
        }
        const request = parseJson(pairingRequestSchema, plaintext);
        if (request === null)
          throw new PairingProtocolError("PAIRING_REQUEST_INVALID");

        const credential = await this.dependencies.credentialStore.load();
        if (credential === null || credential.role !== "hub")
          throw new PairingProtocolError("PAIRING_HUB_NOT_READY");
        if (
          credential.devices.some(
            ({ deviceId }) => deviceId === request.deviceId,
          )
        )
          throw new PairingProtocolError("PAIRING_DEVICE_EXISTS");
        if (credential.devices.length >= 64)
          throw new PairingProtocolError("PAIRING_DEVICE_LIMIT");

        await this.dependencies.credentialStore.save({
          ...credential,
          devices: [
            ...credential.devices,
            {
              deviceId: request.deviceId,
              deviceKey: request.deviceKey,
              addedAt: new Date(this.now()).toISOString(),
            },
          ],
        });
        return this.dependencies.cipher.seal({
          kind: "pair",
          credentialId: header.credentialId,
          key: secret,
          plaintext: Buffer.from(
            JSON.stringify({
              v: 1,
              type: "pair_accepted",
              deviceId: request.deviceId,
            }),
            "utf8",
          ),
        });
      },
    );
  }
}

function parseJson<T extends z.ZodType>(
  schema: T,
  value: Buffer,
): z.infer<T> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value)
    throw new PairingProtocolError("PAIRING_REQUEST_INVALID");
  return key;
}
