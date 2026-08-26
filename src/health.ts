import { loadConfig } from "./config";

/**
 * UNAUTHENTICATED. Anyone who finds the Worker URL can read this response, so
 * it reports exactly three things: that the Worker is alive, what schema
 * version the DATABASE believes it is on, and whether configuration is
 * complete. No owner id, no client id, no row counts.
 *
 * A row count would be a small leak with no upside: "42 people" tells a
 * stranger the instance is in use and worth a second look.
 */
export async function health(env: Env, requestId: string): Promise<Response> {
  let configured = true;
  try {
    loadConfig(env);
  } catch {
    // Deliberately swallowed. This route answers either way; it just says which.
    // The reason is not reported here - `configErrorResponse` from Task 1 does
    // that on the routes that actually refuse.
    configured = false;
  }

  return json(
    {
      status: "ok",
      schema_version: await appliedSchemaVersion(env),
      configured,
      request_id: requestId,
    },
    200
  );
}

/**
 * What the DATABASE believes, not what the code believes.
 *
 * Wrangler's D1 migrations record each applied file in `d1_migrations`. Reading
 * it means `/health` surfaces the disagreement it exists to catch: new code
 * deployed against a database nobody ran `--remote` migrations on. A hardcoded
 * constant would report the code's opinion and agree with itself forever.
 *
 * Returns null rather than throwing when the table is absent, which is the
 * state of a database that has never been migrated at all - a real situation
 * during a first deploy, and one an operator needs `/health` to survive.
 */
async function appliedSchemaVersion(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"
    ).first<{ name: string }>();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      // A cached health check is not a health check.
      "cache-control": "no-store",
    },
  });
}
