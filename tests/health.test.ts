import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// No real migration file could ever produce this name, so a hardcoded literal
// in health.ts cannot coincidentally match it the way it could match a value
// read from the database's own bookkeeping.
const SYNTHETIC_MIGRATION_NAME = "9999_marker_for_this_test.sql";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
});

afterEach(async () => {
  // d1_migrations is shared across every test file in this run (isolate:
  // false, maxWorkers: 1), so the synthetic row must not outlive this test.
  await env.DB.prepare("DELETE FROM d1_migrations WHERE name = ?")
    .bind(SYNTHETIC_MIGRATION_NAME)
    .run();
});

describe("GET /health", () => {
  it("reports ok, the applied schema version, and configured state", async () => {
    // Querying d1_migrations for the "real" last migration and asserting the
    // handler agrees is circular: both sides read the same source, so they
    // can be wrong together (e.g. if the handler were changed to return a
    // hardcoded literal that happens to equal today's last migration). Insert
    // a synthetic row instead, with a name no real migration could produce,
    // and assert the handler reports exactly that.
    await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)")
      .bind(SYNTHETIC_MIGRATION_NAME)
      .run();

    const response = await SELF.fetch("https://example.test/health");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      schema_version: string | null;
      configured: boolean;
    };
    expect(body.status).toBe("ok");
    expect(body.schema_version).toBe(SYNTHETIC_MIGRATION_NAME);
    expect(body.configured).toBe(true);
  });

  it("REVEALS NOTHING about the owner or the data", async () => {
    const response = await SELF.fetch("https://example.test/health");
    const text = await response.text();
    // Unauthenticated route. Anyone who finds the URL can read this.
    expect(text).not.toContain("OWNER");
    expect(text).not.toContain(env.OWNER_GITHUB_USER_ID);
    expect(text).not.toContain(env.GITHUB_CLIENT_ID);
    expect(text.toLowerCase()).not.toContain("secret");
    // No row counts either: "42 people" tells a stranger the instance is in use.
    expect(text).not.toMatch(/\bcount\b/i);
  });

  it("carries a request id so a report can be matched to a log line", async () => {
    const response = await SELF.fetch("https://example.test/health");
    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("is never cached, because a cached health check is not a health check", async () => {
    const response = await SELF.fetch("https://example.test/health");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("STILL ANSWERS when configuration is incomplete, and says so", async () => {
    // The one place /health diverges from fail-closed: an operator debugging
    // an unconfigured instance needs something to answer, and this route
    // holds no data. Tools stay refused - see Task 7.
    const broken = { ...env, OWNER_GITHUB_USER_ID: "" } as never;
    const { health } = await import("../src/health");
    const response = await health(broken, "r1");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; configured: boolean };
    expect(body.status).toBe("ok");
    expect(body.configured).toBe(false);
  });

  it("reports a null schema version rather than failing when migrations have not run", async () => {
    // A real DROP TABLE would corrupt the shared D1 instance that every other
    // test file's setup migrates against (this suite runs with isolate:
    // false), so the missing-table case is simulated with a stand-in DB
    // binding instead of mutating the real one.
    const dbWithoutMigrationsTable = {
      prepare: () => ({
        first: async () => {
          throw new Error("no such table: d1_migrations");
        },
      }),
    };
    const { health } = await import("../src/health");
    const response = await health({ ...env, DB: dbWithoutMigrationsTable } as never, "r1");
    const body = (await response.json()) as { schema_version: string | null };
    expect(body.schema_version).toBeNull();
  });
});

describe("everything else", () => {
  it("404s an unknown path", async () => {
    const response = await SELF.fetch("https://example.test/nope");
    expect(response.status).toBe(404);
  });
});
