import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/relay-worker.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      exclude: [
        "src/daemon/production.ts",
        "src/cli/context.ts",
        "src/relay/cloudflare.ts",
        "src/relay/hub-connector.ts",
        "src/platform/command.ts",
        "src/platform/current.ts",
      ],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 80,
      },
    },
  },
});
