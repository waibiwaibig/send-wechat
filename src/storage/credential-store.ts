import { z } from "zod";

import type { CredentialStore } from "../runtime/ports.js";
import type { SecretBundle } from "../runtime/state.js";

const SERVICE = "send-wechat";
const ACCOUNT = "binding";

const secretSchema = z
  .object({
    schemaVersion: z.literal(1),
    botToken: z
      .string()
      .min(1)
      .max(64 * 1024),
    contextToken: z
      .string()
      .min(1)
      .max(64 * 1024)
      .nullable(),
  })
  .strict();

type KeyringEntry = {
  getPassword(): Promise<string | null | undefined> | string | null | undefined;
  setPassword(value: string): unknown;
  deletePassword(): unknown;
};

export type NativeCredentialStoreDependencies = {
  entryFactory?: (service: string, account: string) => KeyringEntry;
};

export class CredentialStoreError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "CredentialStoreError";
  }
}

export class NativeCredentialStore implements CredentialStore {
  public constructor(
    private readonly dependencies: NativeCredentialStoreDependencies = {},
  ) {}

  public async load(): Promise<SecretBundle | null> {
    const entry = await this.entry();
    let value: string | null;
    try {
      value = (await entry.getPassword()) ?? null;
    } catch {
      throw new CredentialStoreError("CREDENTIAL_STORE_UNAVAILABLE");
    }
    if (value === null) return null;
    if (Buffer.byteLength(value, "utf8") > 132 * 1024) {
      throw new CredentialStoreError("CREDENTIAL_SCHEMA_INCOMPATIBLE");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      throw new CredentialStoreError("CREDENTIAL_SCHEMA_INCOMPATIBLE");
    }
    const parsed = secretSchema.safeParse(decoded);
    if (!parsed.success)
      throw new CredentialStoreError("CREDENTIAL_SCHEMA_INCOMPATIBLE");
    return parsed.data;
  }

  public async save(secret: SecretBundle): Promise<void> {
    const parsed = secretSchema.safeParse(secret);
    if (!parsed.success)
      throw new CredentialStoreError("CREDENTIAL_SCHEMA_INVALID");
    try {
      await (await this.entry()).setPassword(JSON.stringify(parsed.data));
    } catch {
      throw new CredentialStoreError("CREDENTIAL_STORE_UNAVAILABLE");
    }
  }

  public async delete(): Promise<void> {
    try {
      await (await this.entry()).deletePassword();
    } catch {
      throw new CredentialStoreError("CREDENTIAL_STORE_UNAVAILABLE");
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
    if (this.dependencies.entryFactory !== undefined) {
      return this.dependencies.entryFactory(SERVICE, ACCOUNT);
    }
    try {
      const { Entry } = await import("@napi-rs/keyring");
      return new Entry(SERVICE, ACCOUNT);
    } catch {
      throw new CredentialStoreError("CREDENTIAL_STORE_UNAVAILABLE");
    }
  }
}
