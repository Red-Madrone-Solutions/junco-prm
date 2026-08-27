import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isDailyQuotaError, quotaErrorResponse } from "../src/quota";

describe("isDailyQuotaError", () => {
  // Cloudflare's exact wording, captured from a live exhaustion on 2026-08-27.
  it("recognises the KV daily read limit", () => {
    expect(isDailyQuotaError(new Error("KV get() limit exceeded for the day."))).toBe(true);
  });

  it("recognises the write, delete, and list forms", () => {
    for (const op of ["put", "delete", "list"]) {
      expect(isDailyQuotaError(new Error(`KV ${op}() limit exceeded for the day.`))).toBe(true);
    }
  });

  // THE ONE THAT KEEPS THIS HONEST. A broad match on "limit" would report a
  // real defect as "come back tomorrow", which is the worst possible advice
  // for something that will still be broken tomorrow.
  it("does not treat a size or rate limit as a daily allowance", () => {
    expect(isDailyQuotaError(new Error("KV value too large: limit is 25 MiB"))).toBe(false);
    expect(isDailyQuotaError(new Error("D1_ERROR: too many SQL variables"))).toBe(false);
    expect(isDailyQuotaError(new Error("Rate limit exceeded"))).toBe(false);
    expect(isDailyQuotaError(new Error("statement exceeds the 100 KB limit"))).toBe(false);
  });

  it("is not fooled by a non-Error", () => {
    expect(isDailyQuotaError("KV get() limit exceeded for the day.")).toBe(false);
    expect(isDailyQuotaError(null)).toBe(false);
    expect(isDailyQuotaError(undefined)).toBe(false);
  });
});

describe("quotaErrorResponse", () => {
  const at = (iso: string) => quotaErrorResponse(new Error("KV get() limit exceeded for the day."), "r1", new Date(iso));

  it("answers 503, not 500, because the instance is not broken", async () => {
    expect(at("2026-08-27T22:05:00Z").status).toBe(503);
  });

  it("names the next midnight UTC as the reset", async () => {
    const body = await at("2026-08-27T22:05:00Z").json() as { resets_at: string };
    expect(body.resets_at).toBe("2026-08-28T00:00:00.000Z");
  });

  // A minute before the reset must not roll forward a whole day, and a minute
  // after must not point at a moment already past.
  it("computes the reset correctly at the edges", async () => {
    const before = await at("2026-08-27T23:59:00Z").json() as { resets_at: string };
    expect(before.resets_at).toBe("2026-08-28T00:00:00.000Z");
    const after = await at("2026-08-28T00:01:00Z").json() as { resets_at: string };
    expect(after.resets_at).toBe("2026-08-29T00:00:00.000Z");
  });

  it("sets Retry-After to the seconds remaining", () => {
    expect(at("2026-08-27T23:59:00Z").headers.get("retry-after")).toBe("60");
  });

  it("never reports a Retry-After of zero or less", () => {
    expect(Number(at("2026-08-27T23:59:59.999Z").headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("carries the request id and a next step", async () => {
    const body = await at("2026-08-27T22:05:00Z").json() as { request_id: string; next: string; error: string };
    expect(body.error).toBe("quota_exhausted");
    expect(body.request_id).toBe("r1");
    expect(body.next).toMatch(/retry|Paid/i);
  });
});

/**
 * THE WIRING, not the helpers.
 *
 * The two describe blocks above pass whether or not `src/index.ts` ever calls
 * either function. Deleting the catch in the fetch handler leaves them green,
 * which would make them exactly the kind of test this project has shipped
 * seventeen of: correctly named, passing, guarding nothing.
 *
 * These drive the real Worker entry point with a KV binding that throws the
 * way Cloudflare's does when the daily allowance is spent, and assert the
 * caller gets a 503 that explains itself rather than Cloudflare's Error 1101
 * page.
 */
describe("the Worker translates a spent allowance at the boundary", () => {
  const exhausted = (message: string) => {
    const get = () => {
      throw new Error(message);
    };
    return { ...env, OAUTH_KV: { ...env.OAUTH_KV, get, getWithMetadata: get } } as unknown as Env;
  };

  const call = async (patched: Env) => {
    const worker = (await import("../src/index")).default;
    // Three colon-separated parts. The provider only reads KV when the token
    // matches its internal shape (oauth-provider.js:2666), so a token of any
    // other form returns 401 before the binding is ever touched and would
    // make this test pass for the wrong reason.
    const request = new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer user:grant:secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    return worker.fetch(request, patched, {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext);
  };

  it("answers 503 with quota_exhausted instead of letting the exception escape", async () => {
    const response = await call(exhausted("KV get() limit exceeded for the day."));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; resets_at: string };
    expect(body.error).toBe("quota_exhausted");
    expect(body.resets_at).toMatch(/T00:00:00\.000Z$/);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  /**
   * A real fault must still reach Cloudflare as a real fault. Reporting a bug
   * as "come back tomorrow" is the worst possible advice for something that
   * will still be broken tomorrow.
   */
  it("lets a genuine failure keep throwing", async () => {
    await expect(call(exhausted("KV value too large: limit is 25 MiB"))).rejects.toThrow(/25 MiB/);
  });
});
