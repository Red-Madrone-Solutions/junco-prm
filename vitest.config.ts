import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  test: {
    projects: [
      {
        // The Worker suite, unchanged. Everything here was previously at the
        // top level of this file and behaves identically; it is nested only
        // so a second project can exist beside it.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.example.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                // Test-only. Never real credentials - this file is committed,
                // and a secret in it is a secret in the repository forever.
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
          name: "workers",
          include: ["tests/**/*.test.ts"],
          setupFiles: ["./tests/apply-migrations.ts"],
          isolate: false,
          maxWorkers: 1,
          // Explicit because the two projects have different maxWorkers;
          // vitest requires a unique groupOrder in that case and errors
          // otherwise when both projects run together.
          sequence: { groupOrder: 0 },
        },
      },
      {
        // The backup and restore scripts. Plain Node, because they shell out
        // to wrangler and touch the filesystem, neither of which workerd can
        // do. Kept out of the Worker's tsconfig for the same reason.
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/**/*.test.mjs"],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
