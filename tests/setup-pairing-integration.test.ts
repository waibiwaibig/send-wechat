import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayCipher } from "../src/relay/crypto.js";
import { PairingInvitations } from "../src/relay/invitation.js";
import { PairingClient, PairingHub } from "../src/relay/pairing.js";
import { SetupCoordinator } from "../src/setup/coordinator.js";
import { OwnerOnlyClientRelayCredentialStore } from "../src/storage/client-relay-credential-store.js";
import { JsonInstallationStore } from "../src/storage/installation-store.js";
import type { HubRelayCredential } from "../src/storage/relay-credential-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "pairing persistence and real handshake",
  () => {
    it("keeps the same invitation usable after local save failure, then pairs with readable local files", async () => {
      const root = await mkdtemp(
        join(tmpdir(), "send-wechat-persist-handshake-"),
      );
      roots.push(root);
      const credentials = new OwnerOnlyClientRelayCredentialStore(
        join(root, "client-credential.json"),
      );
      const installation = new JsonInstallationStore(
        join(root, "installation.json"),
      );
      const invitations = new PairingInvitations();
      const invitation = invitations.issue("https://test.workers.dev");
      let hubCredential: HubRelayCredential = {
        schemaVersion: 1,
        role: "hub",
        hubAuthToken: Buffer.alloc(32, 3).toString("base64url"),
        devices: [],
      };
      const hub = new PairingHub({
        invitations,
        cipher: new RelayCipher(),
        credentialStore: {
          load: async () => hubCredential,
          save: async (value) => {
            if (value.role !== "hub") throw new Error("unexpected role");
            hubCredential = value;
          },
        },
      });
      let failSave = true;
      const accept = vi.fn(async (frame: Buffer) => {
        const local = await credentials.load();
        const installed = await installation.load();
        expect(local?.role).toBe("client");
        expect(installed).toMatchObject({
          role: "client",
          deviceId: local?.deviceId,
        });
        return await hub.accept(frame);
      });
      const dependencies: ConstructorParameters<typeof SetupCoordinator>[0] = {
        installationStore: {
          load: async () => await installation.load(),
          save: async (value) => {
            if (failSave)
              throw Object.assign(new Error("test disk full"), {
                code: "ENOSPC",
              });
            await installation.save(value);
          },
          delete: async () => await installation.delete(),
        },
        credentialStore: credentials,
        pairDevice: async (encoded, persist) => {
          const client = new PairingClient();
          const attempt = client.begin(encoded);
          await persist({
            relayUrl: attempt.relayUrl,
            credential: attempt.credential,
          });
          const response = await accept(attempt.requestFrame);
          return {
            relayUrl: attempt.relayUrl,
            credential: client.complete(attempt, response),
          };
        },
        prepare: vi.fn(),
        provision: vi.fn(),
        deprovision: vi.fn(),
        service: { status: vi.fn(), install: vi.fn(), start: vi.fn() },
        ipc: vi.fn(),
        randomBytes: (size) => Buffer.alloc(size, 4),
        sleep: vi.fn(),
      };
      await expect(
        new SetupCoordinator(dependencies).setup({ pair: invitation }),
      ).rejects.toBeDefined();
      expect(accept).not.toHaveBeenCalled();
      expect(hubCredential.devices).toHaveLength(0);
      expect(await credentials.load()).toBeNull();
      expect(await installation.load()).toBeNull();

      failSave = false;
      await expect(
        new SetupCoordinator(dependencies).setup({ pair: invitation }),
      ).resolves.toMatchObject({
        ok: true,
        result: { role: "client", state: "paired" },
      });
      expect(accept).toHaveBeenCalledOnce();
      expect(hubCredential.devices).toHaveLength(1);
      expect(dependencies.service.install).not.toHaveBeenCalled();
    });
  },
);
