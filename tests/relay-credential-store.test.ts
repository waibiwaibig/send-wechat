import { describe, expect, it } from "vitest";

import {
  NativeRelayCredentialStore,
  RelayCredentialStoreError,
  type RelayCredential,
} from "../src/storage/relay-credential-store.js";

const hubCredential: RelayCredential = {
  schemaVersion: 1,
  role: "hub",
  hubAuthToken: Buffer.alloc(32, 1).toString("base64url"),
  devices: [
    {
      deviceId: Buffer.alloc(16, 2).toString("base64url"),
      deviceKey: Buffer.alloc(32, 3).toString("base64url"),
      addedAt: "2026-08-24T08:00:00.000Z",
    },
  ],
};

describe("native personal-relay credential store", () => {
  it("round-trips strict Hub and client credentials in a distinct keyring entry", async () => {
    let stored: string | null = null;
    const entries: Array<{ service: string; account: string }> = [];
    const store = new NativeRelayCredentialStore({
      entryFactory(service, account) {
        entries.push({ service, account });
        return {
          getPassword: () => stored,
          setPassword: (value) => {
            stored = value;
          },
          deletePassword: () => {
            stored = null;
          },
        };
      },
    });

    await store.save(hubCredential);
    await expect(store.load()).resolves.toEqual(hubCredential);

    const client: RelayCredential = {
      schemaVersion: 1,
      role: "client",
      deviceId: Buffer.alloc(16, 4).toString("base64url"),
      deviceKey: Buffer.alloc(32, 5).toString("base64url"),
    };
    await store.save(client);
    await expect(store.load()).resolves.toEqual(client);
    await store.delete();
    await expect(store.load()).resolves.toBeNull();
    expect(entries.every(({ service }) => service === "send-wechat")).toBe(
      true,
    );
    expect(entries.every(({ account }) => account === "personal-relay")).toBe(
      true,
    );
  });

  it("fails closed for incompatible, duplicate, oversized, and unavailable credentials", async () => {
    let stored: string | null = JSON.stringify({
      ...hubCredential,
      schemaVersion: 2,
    });
    const entry = {
      getPassword: () => stored,
      setPassword: (value: string) => {
        stored = value;
      },
      deletePassword: () => {
        stored = null;
      },
    };
    const store = new NativeRelayCredentialStore({ entryFactory: () => entry });
    await expect(store.load()).rejects.toMatchObject({
      code: "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
    });

    stored = JSON.stringify({
      ...hubCredential,
      devices: [hubCredential.devices[0], hubCredential.devices[0]],
    });
    await expect(store.load()).rejects.toMatchObject({
      code: "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
    });
    stored = "x".repeat(64 * 1024 + 1);
    await expect(store.load()).rejects.toMatchObject({
      code: "RELAY_CREDENTIAL_SCHEMA_INCOMPATIBLE",
    });
    await expect(
      store.save({ ...hubCredential, hubAuthToken: "not-a-key" } as never),
    ).rejects.toMatchObject({ code: "RELAY_CREDENTIAL_SCHEMA_INVALID" });

    const unavailable = new NativeRelayCredentialStore({
      entryFactory: () => ({
        getPassword: () => {
          throw new Error("keyring unavailable");
        },
        setPassword: () => {
          throw new Error("keyring unavailable");
        },
        deletePassword: () => {
          throw new Error("keyring unavailable");
        },
      }),
    });
    await expect(unavailable.load()).rejects.toBeInstanceOf(
      RelayCredentialStoreError,
    );
    await expect(unavailable.save(hubCredential)).rejects.toMatchObject({
      code: "RELAY_CREDENTIAL_STORE_UNAVAILABLE",
    });
    await expect(unavailable.delete()).rejects.toMatchObject({
      code: "RELAY_CREDENTIAL_STORE_UNAVAILABLE",
    });
  });
});
