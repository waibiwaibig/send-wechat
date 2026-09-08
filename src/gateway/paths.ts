import { dirname, join } from "node:path";

import type { PlatformPaths } from "../platform/paths.js";

export function gatewayPaths(hub: PlatformPaths): {
  directory: string;
  config: string;
  state: string;
  status: string;
  service: PlatformPaths;
} {
  const directory = join(hub.stateDir, "gateway");
  const serviceName =
    hub.platform === "darwin"
      ? "io.github.waibiwaibig.send-wechat.gateway.plist"
      : hub.platform === "linux"
        ? "send-wechat-gateway.service"
        : "gateway-service.ps1";
  return {
    directory,
    config: join(directory, "config.json"),
    state: join(directory, "state.json"),
    status: join(directory, "status.json"),
    service: {
      ...hub,
      stateDir: directory,
      serviceConfigPath: join(dirname(hub.serviceConfigPath), serviceName),
    },
  };
}
