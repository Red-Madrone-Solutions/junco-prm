import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Test-only. Never real credentials - this file is committed, and a
          // secret in it is a secret in the repository forever.
          GITHUB_CLIENT_ID: "Iv1.test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          COOKIE_ENCRYPTION_KEY: "0".repeat(64),
          OWNER_GITHUB_USER_ID: "583231",
          OWNER_TIMEZONE: "UTC",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/apply-migrations.ts"],
    isolate: false,
    maxWorkers: 1,
  },
});
