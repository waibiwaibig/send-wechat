import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const invitationPayloadSchema = z
  .object({
    v: z.literal(1),
    relay: z.string().max(2048),
    invitationId: z.string().length(22).regex(BASE64URL),
    secret: z.string().length(43).regex(BASE64URL),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type PairingInvitation = z.infer<typeof invitationPayloadSchema>;

export class PairingInvitationError extends Error {
  public constructor(public readonly code = "PAIRING_INVITATION_INVALID") {
    super(code);
    this.name = "PairingInvitationError";
  }
}

type PendingInvitation = {
  relay: string;
  secret: Buffer;
  expiresAt: number;
  used: boolean;
  usedRequestDigest?: Buffer;
  usedResponse?: Buffer;
};

export type PairingInvitationsDependencies = {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
};

const INVITATION_LIFETIME_MS = 10 * 60 * 1000;
const MAX_PENDING_INVITATIONS = 16;

export class PairingInvitations {
  private readonly pending = new Map<string, PendingInvitation>();
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;

  public constructor(dependencies: PairingInvitationsDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  }

  public issue(relayValue: string): string {
    const relay = validateRelayUrl(relayValue);
    this.prune();
    if (this.pending.size >= MAX_PENDING_INVITATIONS)
      throw new PairingInvitationError("PAIRING_INVITATION_LIMIT");

    const invitationId = this.randomBytes(16).toString("base64url");
    const secret = this.randomBytes(32);
    if (
      invitationId.length !== 22 ||
      secret.byteLength !== 32 ||
      this.pending.has(invitationId)
    )
      throw new PairingInvitationError();
    const expiresAt = this.now() + INVITATION_LIFETIME_MS;
    this.pending.set(invitationId, {
      relay,
      secret: Buffer.from(secret),
      expiresAt,
      used: false,
    });
    const payload: PairingInvitation = {
      v: 1,
      relay,
      invitationId,
      secret: secret.toString("base64url"),
      expiresAt,
    };
    return `sw1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  }

  public consume(invitationId: string, secretValue: string): { relay: string } {
    const invitation = this.pending.get(invitationId);
    if (invitation === undefined) throw new PairingInvitationError();
    if (invitation.used)
      throw new PairingInvitationError("PAIRING_INVITATION_USED");
    if (this.now() > invitation.expiresAt)
      throw new PairingInvitationError("PAIRING_INVITATION_EXPIRED");

    let provided: Buffer;
    try {
      provided = Buffer.from(secretValue, "base64url");
    } catch {
      throw new PairingInvitationError();
    }
    if (
      provided.byteLength !== invitation.secret.byteLength ||
      provided.toString("base64url") !== secretValue ||
      !timingSafeEqual(provided, invitation.secret)
    )
      throw new PairingInvitationError();

    invitation.used = true;
    return { relay: invitation.relay };
  }

  public async accept(
    invitationId: string,
    requestFrame: Buffer,
    operation: (secret: Buffer, relay: string) => Promise<Buffer>,
  ): Promise<Buffer> {
    const invitation = this.pending.get(invitationId);
    if (invitation === undefined) throw new PairingInvitationError();
    const digest = createHash("sha256").update(requestFrame).digest();
    if (invitation.used) {
      if (
        invitation.usedRequestDigest !== undefined &&
        invitation.usedResponse !== undefined &&
        timingSafeEqual(digest, invitation.usedRequestDigest)
      )
        return Buffer.from(invitation.usedResponse);
      throw new PairingInvitationError("PAIRING_INVITATION_USED");
    }
    if (this.now() > invitation.expiresAt)
      throw new PairingInvitationError("PAIRING_INVITATION_EXPIRED");

    const response = await operation(
      Buffer.from(invitation.secret),
      invitation.relay,
    );
    if (response.byteLength === 0 || response.byteLength > 12 * 1024 * 1024)
      throw new PairingInvitationError();
    invitation.used = true;
    invitation.usedRequestDigest = digest;
    invitation.usedResponse = Buffer.from(response);
    return Buffer.from(response);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, invitation] of this.pending) {
      if (invitation.expiresAt + INVITATION_LIFETIME_MS < now)
        this.pending.delete(id);
    }
  }
}

export function parsePairingInvitation(value: string): PairingInvitation {
  if (!value.startsWith("sw1.") || value.length > 4096)
    throw new PairingInvitationError();
  const encoded = value.slice(4);
  if (encoded.length === 0 || !BASE64URL.test(encoded))
    throw new PairingInvitationError();

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new PairingInvitationError();
  }
  const parsed = invitationPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new PairingInvitationError();

  validateRelayUrl(parsed.data.relay);
  return parsed.data;
}

function validateRelayUrl(value: string): string {
  let relay: URL;
  try {
    relay = new URL(value);
  } catch {
    throw new PairingInvitationError();
  }
  if (
    relay.protocol !== "https:" ||
    !relay.hostname.endsWith(".workers.dev") ||
    relay.username !== "" ||
    relay.password !== "" ||
    relay.port !== "" ||
    relay.pathname !== "/" ||
    relay.search !== "" ||
    relay.hash !== ""
  )
    throw new PairingInvitationError();
  return relay.toString().replace(/\/$/, "");
}
