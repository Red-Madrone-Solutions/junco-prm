import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { beginConsent, ConsentError, consumeConsent } from "../src/auth/transaction";

const authRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: [],
  state: "claude-state",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
};

function requestWithCookie(cookie?: string): Request {
  const headers = cookie ? { cookie: cookie.split(";")[0]! } : undefined;
  return new Request("https://prm.example.test/authorize", { headers });
}

beforeEach(async () => {
  const listed = await env.OAUTH_KV.list({ prefix: "pending:" });
  await Promise.all(listed.keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("beginConsent", () => {
  it("sets a cookie bound to this browser and no other", async () => {
    // SameSite=Strict is deliberate here and differs from the transaction
    // cookie's Lax - see transaction.ts:44-47. The only request that reads
    // this cookie is a form submission from our own consent page.
    const { cookie } = await beginConsent(env, requestWithCookie(), authRequest);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });
});

describe("consumeConsent", () => {
  it("REFUSES a cookieless call and leaves the pending record untouched", async () => {
    // The property the no_cookie guard exists for: a caller with no cookie
    // must not cause a KV read or write for the record its handle names.
    const { handle } = await beginConsent(env, requestWithCookie(), authRequest);

    await expect(consumeConsent(env, requestWithCookie(), handle)).rejects.toThrow(ConsentError);

    const stillPending = await env.OAUTH_KV.get(`pending:${handle}`);
    expect(stillPending).not.toBeNull();
  });

  it("returns the auth request when the cookie matches", async () => {
    const { handle, cookie } = await beginConsent(env, requestWithCookie(), authRequest);
    const out = await consumeConsent(env, requestWithCookie(cookie), handle);
    expect(out.authRequest.clientId).toBe("client-1");
  });
});
