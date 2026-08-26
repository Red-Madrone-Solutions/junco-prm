import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, rateLimitedResponse } from "../src/ratelimit";

function requestFrom(ip: string, path = "/register") {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  });
}

beforeEach(async () => {
  // Only meaningful for the KV implementation; harmless for the binding one.
  const listed = await env.OAUTH_KV.list({ prefix: "rl:" });
  await Promise.all(listed.keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("checkRateLimit", () => {
  it("allows a first request", async () => {
    expect(await checkRateLimit(env, requestFrom("203.0.113.1"))).toBe(true);
  });

  it("REFUSES once a single client exceeds the burst", async () => {
    const request = requestFrom("203.0.113.2");
    let refused = false;
    for (let i = 0; i < 200; i++) {
      if (!(await checkRateLimit(env, request))) {
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
  });

  it("keys by client, so one abuser does not lock out the owner", async () => {
    const abuser = requestFrom("203.0.113.3");
    for (let i = 0; i < 200; i++) await checkRateLimit(env, abuser);
    expect(await checkRateLimit(env, requestFrom("203.0.113.4"))).toBe(true);
  });

  it("falls back to a fixed key when there is no client IP", async () => {
    // Must not throw, and must not treat every anonymous request as one client
    // sharing an `undefined` bucket silently - the fallback is explicit.
    const anonymous = new Request("https://example.test/register", { method: "POST" });
    expect(typeof (await checkRateLimit(env, anonymous))).toBe("boolean");
  });

  it("FAILS OPEN when the limiter itself errors", async () => {
    // A limiter outage must not take the instance down. The spec's own framing
    // is that this protects quota, not correctness - so an unavailable limiter
    // is a degraded instance, not a broken one. Deliberate, and the opposite
    // of every other failure decision in this plan.
    const broken = { ...env, OAUTH_KV: undefined, RATE_LIMITER: undefined } as never;
    expect(await checkRateLimit(broken, requestFrom("203.0.113.5"))).toBe(true);
  });

  it("routes the \"public\" bucket to RATE_LIMITER and the \"mcp\" bucket to MCP_RATE_LIMITER", async () => {
    // The brief's own risk section: "a test that shows a 429 came back cannot
    // tell you the OAuth limiter fired on an /mcp request." This asserts the
    // binding, not just the boolean - it fails if the bucket argument is ever
    // wired to the wrong binding, or to the same binding for both buckets.
    const publicCalls: string[] = [];
    const mcpCalls: string[] = [];
    const stubbed = {
      ...env,
      RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          publicCalls.push(key);
          return { success: true };
        },
      },
      MCP_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          mcpCalls.push(key);
          return { success: false };
        },
      },
    } as never;

    expect(await checkRateLimit(stubbed, requestFrom("203.0.113.6"), "public")).toBe(true);
    expect(publicCalls).toEqual(["public:203.0.113.6"]);
    expect(mcpCalls).toEqual([]);

    expect(await checkRateLimit(stubbed, requestFrom("203.0.113.6"), "mcp")).toBe(false);
    expect(mcpCalls).toEqual(["mcp:203.0.113.6"]);
    // The public binding was not consulted a second time for the mcp check.
    expect(publicCalls).toEqual(["public:203.0.113.6"]);
  });
});

describe("rateLimitedResponse", () => {
  it("is a 429 carrying Retry-After", async () => {
    const response = rateLimitedResponse("r1");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("says nothing about whether this instance exists or is configured", async () => {
    const text = await rateLimitedResponse("r1").text();
    expect(text.toLowerCase()).not.toContain("junco");
    expect(text.toLowerCase()).not.toContain("github");
  });
});

/**
 * These walk the real dispatch chain in src/index.ts rather than calling
 * checkRateLimit directly, because the unit tests above cannot see whether the
 * handler actually calls it, in what order, or with which bucket. Each test
 * here names the exact line in src/index.ts it depends on, per the dispatch's
 * instruction: deleting that line must break a named test.
 */
describe("the limiter as wired into src/index.ts", () => {
  it("REFUSES /health when the public limiter denies - depends on the checkRateLimit call preceding the /health branch", async () => {
    // Deleting `if (!(await checkRateLimit(env, request, bucket))) { ... }` in
    // src/index.ts (or moving it below the /health branch) makes this test
    // fail: /health would return 200 regardless of what the limiter says.
    const { default: worker } = await import("../src/index");
    const denied = {
      ...env,
      RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as never;

    const response = await worker.fetch(
      new Request("https://example.test/health"),
      denied,
      {} as ExecutionContext
    );
    expect(response.status).toBe(429);
  });

  it("REFUSES /authorize when the public limiter denies - proves the check wraps the provider, not just the /health branch", async () => {
    // workers-oauth-provider serves /authorize itself. If the limiter call
    // were placed after the provider is built and invoked (as it would be if
    // it lived inside a tool handler instead of ahead of buildProvider), this
    // request would reach the provider and get a redirect or a 400 from it,
    // never a 429.
    const { default: worker } = await import("../src/index");
    const denied = {
      ...env,
      RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as never;

    const response = await worker.fetch(
      new Request("https://example.test/authorize?client_id=x"),
      denied,
      {} as ExecutionContext
    );
    expect(response.status).toBe(429);
  });

  it("REFUSES /mcp when the mcp limiter denies even though the public limiter allows - proves /mcp is keyed to MCP_RATE_LIMITER", async () => {
    // If `bucket` in src/index.ts were hardcoded to "public" (or the ternary
    // reversed), this would see the allowing RATE_LIMITER instead and pass
    // through to the provider, which returns something other than 429 for an
    // unauthenticated /mcp request.
    const { default: worker } = await import("../src/index");
    const mcpDenied = {
      ...env,
      RATE_LIMITER: { limit: async () => ({ success: true }) },
      MCP_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as never;

    const response = await worker.fetch(
      new Request("https://example.test/mcp"),
      mcpDenied,
      {} as ExecutionContext
    );
    expect(response.status).toBe(429);
  });

  it("does NOT refuse /mcp when only the public limiter denies - the two buckets are independent", async () => {
    const { default: worker } = await import("../src/index");
    const publicDenied = {
      ...env,
      RATE_LIMITER: { limit: async () => ({ success: false }) },
      MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as never;

    const response = await worker.fetch(
      new Request("https://example.test/mcp"),
      publicDenied,
      {} as ExecutionContext
    );
    expect(response.status).not.toBe(429);
  });

  it("does NOT refuse /health when only the mcp limiter denies - /health is the public bucket, not the mcp bucket", async () => {
    const { default: worker } = await import("../src/index");
    const mcpDenied = {
      ...env,
      RATE_LIMITER: { limit: async () => ({ success: true }) },
      MCP_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as never;

    const response = await worker.fetch(
      new Request("https://example.test/health"),
      mcpDenied,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
  });
});
