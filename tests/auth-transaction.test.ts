import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { beginTransaction, consumeTransaction } from "../src/auth/transaction";

const authRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: [],
  state: "claude-state",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
};

/** A request carrying the cookie a browser would have stored. */
function withCookie(cookie: string): Request {
  return new Request("https://prm.example.test/callback", {
    headers: { cookie: cookie.split(";")[0]! },
  });
}

beforeEach(async () => {
  const listed = await env.OAUTH_KV.list({ prefix: "txn:" });
  await Promise.all(listed.keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("beginTransaction", () => {
  it("returns an opaque handle that is not the auth request", async () => {
    const { handle, cookie } = await beginTransaction(env, authRequest);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The whole defect being fixed: the auth request must not be recoverable
    // from anything that travels through GitHub.
    expect(handle).not.toContain("claude.ai");
    expect(atob(handle.replace(/-/g, "+").replace(/_/g, "/")) ?? "").not.toContain("clientId");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("issues a different handle every time", async () => {
    const a = await beginTransaction(env, authRequest);
    const b = await beginTransaction(env, authRequest);
    expect(a.handle).not.toBe(b.handle);
  });
});

describe("consumeTransaction", () => {
  it("returns the auth request when the cookie matches", async () => {
    const { handle, cookie } = await beginTransaction(env, authRequest);
    const out = await consumeTransaction(env, withCookie(cookie), handle);
    expect(out.clientId).toBe("client-1");
    expect(out.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback");
  });

  it("REFUSES when the browser presents no cookie", async () => {
    // THE TAKEOVER, IN ONE TEST.
    //
    // The attacker started the flow, so the attacker's browser holds the
    // cookie. The owner clicks the attacker's link and arrives with none. If
    // this passes, the owner's identity completes the attacker's authorization
    // and the attacker receives a token that assertOwner will accept.
    const { handle } = await beginTransaction(env, authRequest);
    const noCookie = new Request("https://prm.example.test/callback");
    await expect(consumeTransaction(env, noCookie, handle)).rejects.toThrow();
  });

  it("REFUSES a cookie from a different transaction", async () => {
    const mine = await beginTransaction(env, authRequest);
    const theirs = await beginTransaction(env, authRequest);
    await expect(consumeTransaction(env, withCookie(theirs.cookie), mine.handle)).rejects.toThrow();
  });

  it("REFUSES a replay of a handle that was already consumed", async () => {
    // A captured callback URL must not be reusable.
    const { handle, cookie } = await beginTransaction(env, authRequest);
    await consumeTransaction(env, withCookie(cookie), handle);
    await expect(consumeTransaction(env, withCookie(cookie), handle)).rejects.toThrow();
  });

  it("REFUSES a handle that was never issued", async () => {
    const { cookie } = await beginTransaction(env, authRequest);
    await expect(consumeTransaction(env, withCookie(cookie), "not-a-handle")).rejects.toThrow();
  });

  it("REFUSES a forged state that looks like the old encoded format", async () => {
    // The previous design's state was base64url JSON and was trusted. Anything
    // shaped like it must now be meaningless.
    const forged = btoa(JSON.stringify({ ...authRequest, redirectUri: "https://evil.test/cb" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const { cookie } = await beginTransaction(env, authRequest);
    await expect(consumeTransaction(env, withCookie(cookie), forged)).rejects.toThrow();
  });
});
