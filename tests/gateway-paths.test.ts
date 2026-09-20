import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { gatewayPaths } from "../src/gateway/paths.js";
import type { PlatformPaths } from "../src/platform/paths.js";

function fixture(platform: PlatformPaths["platform"]): PlatformPaths {
  const root = path.join(process.cwd(), "gateway-paths-fixture", platform);
  const stateDir = path.join(root, "state");
  const endpoint = path.join(root, "run", "send-message.sock");
  return {
    platform,
    arch: "x64",
    username: "alice",
    stateDir,
    logDir: path.join(root, "logs"),
    runDir: path.join(root, "run"),
    socketPath: endpoint,
    ipcEndpoint: endpoint,
    stateFile: path.join(stateDir, "state.json"),
    installationFile: path.join(stateDir, "installation.json"),
    idempotencyFile: path.join(stateDir, "idempotency.sqlite3"),
    capabilityFile: path.join(stateDir, "capability"),
    clientCredentialFile: path.join(stateDir, "client-credential.json"),
    tempDir: path.join(stateDir, "tmp"),
    serviceConfigPath: path.join(root, "send-message.plist"),
  };
}

describe("gateway paths", () => {
  it.each([
    ["darwin", "io.github.waibiwaibig.send-message.gateway.wechat.plist"],
    ["linux", "send-message-gateway-wechat.service"],
    ["win32", "gateway-service-wechat.ps1"],
  ] as const)(
    "uses an independent %s service path (%s)",
    (platform, serviceName) => {
      const hub = fixture(platform);
      const gateway = gatewayPaths(hub, "wechat");

      expect(gateway.directory).toBe(
        path.join(hub.stateDir, "gateway", "wechat"),
      );
      expect(gateway.config).toBe(path.join(gateway.directory, "config.json"));
      expect(gateway.state).toBe(path.join(gateway.directory, "state.json"));
      expect(gateway.status).toBe(path.join(gateway.directory, "status.json"));
      expect(gateway.service.stateDir).toBe(gateway.directory);
      expect(gateway.service.serviceConfigPath).toBe(
        path.join(path.dirname(hub.serviceConfigPath), serviceName),
      );
      expect(gateway.service.serviceConfigPath).not.toBe(hub.serviceConfigPath);
      expect(gateway.service.ipcEndpoint).toBe(hub.ipcEndpoint);
      expect(gatewayPaths(hub, "feishu").directory).not.toBe(gateway.directory);
    },
  );
});
