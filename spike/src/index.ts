/**
 * Junco PRM measurement spike. Throwaway.
 *
 * Answers three questions that Cloudflare's own documentation cannot, because
 * two of its pages disagree with each other. Deployed once to a free account,
 * probed by hand, then deleted. See docs/MEASUREMENTS.md for the answers and
 * plan 1 Task 0 for why each question is open.
 *
 * TWO THINGS ABOUT HOW THIS IS BUILT, both of which cost a wasted deploy to
 * learn:
 *
 * 1. EACH REQUEST MEASURES EXACTLY ONE SIZE, taken from a query parameter.
 *    Both limits under test - queries and CPU - are PER INVOCATION. Looping
 *    over several sizes inside one request spends them all against a single
 *    budget, so the first size poisons every size after it, and if the budget
 *    is exceeded the invocation dies with no result at all.
 *
 * 2. THE CPU NUMBER IS NOT MEASURED BY THIS WORKER. Date.now() is frozen in
 *    Workers between I/O operations - a Spectre mitigation - so a tight compute
 *    loop reports zero elapsed time however long it really took. The real CPU
 *    figure comes from `wrangler tail`, which reports it per invocation. What
 *    this Worker contributes is whether the invocation SURVIVES at a given row
 *    count, which is the harder half of the answer anyway: the CPU limit kills
 *    the invocation rather than returning an error.
 */

export interface Env {
  DB: D1Database;
  SPIKE_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/* ------------------------------------------------------------------ */
/* Question 1: does a db.batch() of N statements spend N queries or 1? */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare's Workers limits page lists 50 EXTERNAL subrequests against 1,000
 * to internal services, and D1 is an internal service. D1's own limits page
 * prints 50 for queries per invocation. batch() is documented as sending its
 * statements "inside a single call to the database." Three readings, two of
 * which make a derived chunk cap wrong by a factor of 25.
 *
 * Run one size per request. If 49 succeeds and 50 fails, the printed cap binds
 * and each statement spends a query. If 200 succeeds, it does not.
 */
async function measureBatch(env: Env, n: number) {
  const stmt = env.DB.prepare("INSERT OR REPLACE INTO probe (id, n) VALUES (?, ?)");
  const statements = Array.from({ length: n }, (_, i) => stmt.bind(`k${i}`, i));

  try {
    const results = await env.DB.batch(statements);
    return {
      n,
      ok: true,
      statements_returned: results.length,
      // D1 reports duration and served_by per statement. The first is enough to
      // see, and unlike Date.now() it comes from the database rather than from
      // a clock the runtime freezes.
      first_meta: results[0]?.meta ?? null,
      last_meta: results[results.length - 1]?.meta ?? null,
    };
  } catch (e) {
    return { n, ok: false, error: String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Question 2: how much CPU does one roster row cost?                  */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

/** Same rules as src/normalize.ts in plan 1. Kept in sync by hand; it is a spike. */
function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Exactly what Task 12a will make a row cost: normalize every field,
 * canonicalize twice, and take two SHA-256 digests - one over the identity
 * subset for `external_row_key`, one over the whole row for `content_hash`.
 *
 * The 400-character bio is there on purpose. A real roster row carries a bio or
 * a talk abstract, and it lands in `raw_record` and therefore in the whole-row
 * digest, so leaving it out would measure a row narrower than any real one.
 */
async function costOneRow(i: number): Promise<void> {
  const row = {
    full_name: `  Ada  Lovelace ${i} `,
    preferred_name: "Ada",
    job_title: "Analytical Engine Programmer",
    organization: "  Analytical Society  ",
    email: `Ada+Row${i}@Example.TEST`,
    role: "attendee",
    bio: "x".repeat(400),
  };

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeText(String(value));
  }

  await sha256Hex(
    canonicalJson({
      full_name: normalized.full_name,
      organization: normalized.organization,
    })
  );
  await sha256Hex(canonicalJson(normalized));
}

/**
 * Does the work for exactly `rows` rows and reports that it survived.
 *
 * It reports NO TIMING, deliberately. Date.now() is frozen between I/O in
 * Workers, so any elapsed figure this function computed would be a fiction.
 * Read the real CPU milliseconds from `wrangler tail` while calling this.
 */
async function measureCpu(rows: number) {
  for (let i = 0; i < rows; i++) await costOneRow(i);
  return {
    rows,
    survived: true,
    note: "read cpuTime from `wrangler tail`; Date.now() is frozen in Workers",
  };
}

/* ------------------------------------------------------------------ */
/* Question 3: is the rate-limiting binding available on a free plan?  */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // A size is required rather than defaulted, so a probe can never silently
    // measure something other than what the operator meant.
    const size = url.searchParams.get("n");

    if (url.pathname === "/batch") {
      const n = Number(size);
      if (!Number.isInteger(n) || n < 1 || n > 5000) {
        return json({ error: "pass ?n=<1..5000>, one size per request" }, 400);
      }
      return json({ question: "queries per invocation", ...(await measureBatch(env, n)) });
    }

    if (url.pathname === "/cpu") {
      const n = Number(size);
      if (!Number.isInteger(n) || n < 1 || n > 5000) {
        return json({ error: "pass ?n=<1..5000>, one size per request" }, 400);
      }
      // If this never returns, THAT is the finding: the CPU limit killed the
      // invocation at this row count.
      return json({ question: "cpu per row", ...(await measureCpu(n)) });
    }

    if (url.pathname === "/ratelimit") {
      if (!env.SPIKE_LIMIT) {
        return json({
          question: "ratelimit binding",
          bound: false,
          note: "deploy was accepted but the binding is absent at runtime",
        });
      }
      const { success } = await env.SPIKE_LIMIT.limit({ key: "spike" });
      return json({ question: "ratelimit binding", bound: true, first_call_success: success });
    }

    return json({
      routes: {
        "/batch?n=N": "one db.batch() of N statements",
        "/cpu?n=N": "N rows of normalize + canonicalize + 2x SHA-256",
        "/ratelimit": "is the binding present at runtime",
      },
      reminder: "one size per request; both limits under test are per invocation",
    });
  },
};
