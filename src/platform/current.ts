import { homedir, userInfo } from "node:os";

import {
  resolvePlatformPaths,
  UnsupportedPlatformError,
  type PlatformPaths,
  type SupportedPlatform,
} from "./paths.js";

export function currentPlatformPaths(): PlatformPaths {
  return resolvePlatformPaths({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
    username: userInfo().username,
  });
}

export function currentSupportedPlatform(): SupportedPlatform {
  if (
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
  ) {
    return process.platform;
  }
  throw new UnsupportedPlatformError(
    `platform ${process.platform} is not supported`,
  );
}
