import { z } from "zod";

const SERVICE = "send-wechat";
const ACCOUNT = "personal-relay";
const MAX_STORED_BYTES = 64 * 1024;

const base64Url = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[A-Za-z0-9_-]+$/);

const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  });

const deviceCredentialSchema = z
  .object({
    deviceId: base64Url(22),
    deviceKey: base64Url(43),
    addedAt: timestamp,
  })
  .strict();

const relayCredentialSchema = z.discriminatedUnion("role", [
  z
    .object({
      schemaVersion: z.literal(1),
      role: z.literal("hub"),
      hubAuthToken: base64Url(43),
      devices: z
        .array(deviceCredentialSchema)
        .max(64)
        .refine(
          (devices) =>
            new Set(devices.map(({ deviceId }) => deviceId)).size ===
            devices.length,
        ),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      role: z.literal("client"),
      deviceId: base64Url(22),
      deviceKey: base64Url(43),
    })
    .strict(),
]);

export type RelayCredential = z.infer<typeof relayCredentialSchema>;
export type HubRelayCredential = Extract<RelayCredential, { role: "hub" }>;
export type ClientRelayCredential = Extract<
  RelayCredential,
  { role: "client" }
>;

type KeyringEntry = {
  getPassword(): Promise<string | null | undefined> | string | null | undefined;
  setPassword(value: string): unknown;
  deletePassword(): unknown;
};

export type NativeRelayCredentialStoreDependencies = {
  entryFactory?: (service: string, account: string) => KeyringEntry;
};

export class RelayCredentialStoreError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "RelayCredentialStoreError";
  }
}

export class NativeRelayCredentialStore {
  public constructor(
    private readonly dependencies: NativeRelayCredentialStoreDependencies = {},
  ) {}

  public async load(): Promise<RelayCredential | null> {
    let value: string | null;
    try {
      value = (await (await this.entry()).getPassword()) ?? null;
    } catch (error) {
      if (error instanceof RelayCredentialStoreError) throw error;
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_STORE_UNAVAILABLE");
    }
    if (value === null) return null;
    if (Buffer.byteLength(value, "utf8") > MAX_STORED_BYTES)
      throw new RelayCredentialStoreError(
        "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      );

    let decoded: unknown;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      throw new RelayCredentialStoreError(
        "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      );
    }
    const parsed = relayCredentialSchema.safeParse(decoded);
    if (!parsed.success)
      throw new RelayCredentialStoreError(
        "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
      );
    return parsed.data;
  }

  public async save(credential: RelayCredential): Promise<void> {
    const parsed = relayCredentialSchema.safeParse(credential);
    if (!parsed.success)
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_SCHEMA_INVALID");
    const value = JSON.stringify(parsed.data);
    if (Buffer.byteLength(value, "utf8") > MAX_STORED_BYTES)
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_SCHEMA_INVALID");
    try {
      await (await this.entry()).setPassword(value);
    } catch (error) {
      if (error instanceof RelayCredentialStoreError) throw error;
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_STORE_UNAVAILABLE");
    }
  }

  public async delete(): Promise<void> {
    try {
      await (await this.entry()).deletePassword();
    } catch (error) {
      if (error instanceof RelayCredentialStoreError) throw error;
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_STORE_UNAVAILABLE");
    }
  }

  public async available(): Promise<boolean> {
    try {
      await (await this.entry()).getPassword();
      return true;
    } catch {
      return false;
    }
  }

  private async entry(): Promise<KeyringEntry> {
    if (this.dependencies.entryFactory !== undefined)
      return this.dependencies.entryFactory(SERVICE, ACCOUNT);
    try {
      const { Entry } = await import("@napi-rs/keyring");
      return new Entry(SERVICE, ACCOUNT);
    } catch {
      throw new RelayCredentialStoreError("RELAY_CREDENTIAL_STORE_UNAVAILABLE");
    }
  }
}
