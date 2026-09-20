import { dirname, join } from "node:path";

import type { PlatformPaths } from "../platform/paths.js";
import type { Channel } from "../messaging/channel-router.js";

export function gatewayPaths(
  hub: PlatformPaths,
  channel: Channel,
): {
  directory: string;
  config: string;
  state: string;
  status: string;
  service: PlatformPaths;
} {
  const directory = join(hub.stateDir, "gateway", channel);
  const serviceName =
    hub.platform === "darwin"
      ? `io.github.waibiwaibig.send-message.gateway.${channel}.plist`
      : hub.platform === "linux"
        ? `send-message-gateway-${channel}.service`
        : `gateway-service-${channel}.ps1`;
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
