import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ALLOWED_REDIRECT_URIS, isAllowedRedirect } from "../src/auth/provider";

describe("redirect URI policy", () => {
  it("accepts Anthropic's documented callback exactly", () => {
    expect(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
  });

  it("REFUSES a different path on an allowed host", () => {
    // An earlier draft matched on host, so any path on claude.ai passed. The
    // spec says the documented callback; exact matching is what it asked for,
    // and this is the value that decides where authorization codes go.
    expect(isAllowedRedirect("https://claude.ai/anything-else")).toBe(false);
    expect(isAllowedRedirect("https://claude.ai/")).toBe(false);
  });

  it("accepts a loopback callback over http, the native-app exception", () => {
    expect(isAllowedRedirect("http://127.0.0.1:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirect("http://localhost:6274/oauth/callback")).toBe(true);
  });

  it("REFUSES arbitrary and lookalike hosts", () => {
    expect(isAllowedRedirect("https://evil.test/steal")).toBe(false);
    expect(isAllowedRedirect("https://claude.ai.evil.test/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirect("https://notclaude.ai/api/mcp/auth_callback")).toBe(false);
  });

  it("REFUSES http to a non-loopback host, and non-http schemes", () => {
    expect(isAllowedRedirect("http://claude.ai/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirect("")).toBe(false);
    expect(isAllowedRedirect("not a url")).toBe(false);
  });
});

describe("the provider's own routes", () => {
  it("serves OAuth metadata discovery", async () => {
    const response = await SELF.fetch(
      "https://example.test/.well-known/oauth-authorization-server"
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authorization_endpoint).toContain("/authorize");
    expect(body.token_endpoint).toContain("/token");
    expect(body.registration_endpoint).toContain("/register");
  });

  it("still serves /health, which the provider must not swallow", async () => {
    expect((await SELF.fetch("https://example.test/health")).status).toBe(200);
  });

  it("404s an unknown path rather than treating it as an authorization request", async () => {
    // From this task on, the provider is the fetch handler and everything
    // unmatched reaches the default handler. Without an explicit 404 there,
    // /favicon.ico is parsed as an OAuth authorization request and a browser
    // gets bounced to GitHub.
    const response = await SELF.fetch("https://example.test/favicon.ico");
    expect(response.status).toBe(404);
  });

  it("REFUSES to serve anything when configuration is incomplete", async () => {
    const { default: worker } = await import("../src/index");
    const broken = { ...env, GITHUB_CLIENT_SECRET: "" } as never;
    const response = await worker.fetch(
      new Request("https://example.test/authorize?client_id=x"),
      broken,
      {} as ExecutionContext
    );
    expect(response.status).toBe(503);
  });
});

describe("the consent screen", () => {
  it("names the client and the redirect URI it will deliver to", async () => {
    const { consentPage } = await import("../src/auth/consent");
    const html = await consentPage({
      clientName: "Claude",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      handle: "h",
      githubLoginUrl: "https://github.com/login/oauth/authorize",
    }).text();

    expect(html).toContain("Claude");
    expect(html).toContain("https://claude.ai/api/mcp/auth_callback");
  });

  it("ESCAPES a client name and redirect chosen by whoever registered", async () => {
    // Both are attacker-controlled - anyone can register a client through DCR.
    const { consentPage } = await import("../src/auth/consent");
    const html = await consentPage({
      clientName: '<img src=x onerror="alert(1)">',
      redirectUri: 'https://evil.test/"><script>alert(1)</script>',
      handle: "h",
      githubLoginUrl: "https://github.com/login/oauth/authorize",
    }).text();

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img");
  });

  it("cannot be framed", async () => {
    const { consentPage } = await import("../src/auth/consent");
    const response = consentPage({
      clientName: "Claude",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      handle: "h",
      githubLoginUrl: "https://github.com/login/oauth/authorize",
    });
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("grant props", () => {
  it("carries the numeric id and NOTHING else", async () => {
    const { propsFor } = await import("../src/auth/provider");
    expect(propsFor("583231")).toEqual({ githubUserId: "583231" });
    expect(Object.keys(propsFor("583231"))).toEqual(["githubUserId"]);
  });
});
