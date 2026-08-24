import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.relay.jsonc" },
      miniflare: {
        bindings: { HUB_AUTH_TOKEN: "test-hub-auth-token" },
      },
    }),
  ],
  test: {
    include: ["tests/relay-worker.test.ts"],
    maxWorkers: 1,
    isolate: false,
  },
});
