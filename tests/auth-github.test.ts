import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config";
import {
  authorizeUrl,
  completeCallback,
  exchangeCode,
  GitHubAuthError,
  resolveUserId,
} from "../src/auth/github";

const config: Config = {
  githubClientId: "Iv1.abc123",
  githubClientSecret: "shhh",
  cookieKey: "0".repeat(64),
  ownerGithubUserId: "583231",
  ownerTimezone: "UTC",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("authorizeUrl", () => {
  it("points at GitHub with the client id, callback, and state", () => {
    const url = new URL(authorizeUrl(config, "https://prm.example.test/callback", "st4te"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://prm.example.test/callback");
    expect(url.searchParams.get("state")).toBe("st4te");
  });

  it("REQUESTS NO SCOPES AT ALL", () => {
    // Not an empty scope - absent. /user returns the numeric id unscoped, and
    // asking for read:user by reflex widens the consent screen shown to the
    // stranger this project is trying not to lose.
    const url = new URL(authorizeUrl(config, "https://prm.example.test/callback", "st4te"));
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("never puts the client secret in the URL", () => {
    const url = authorizeUrl(config, "https://prm.example.test/callback", "st4te");
    expect(url).not.toContain("shhh");
  });
});

describe("exchangeCode", () => {
  it("posts the code and returns the access token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "gho_token" }));
    const token = await exchangeCode(config, "the-code");
    expect(token).toBe("gho_token");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://github.com/login/oauth/access_token");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("asks for JSON, because GitHub returns form-encoding by default", async () => {
    // Without an Accept header GitHub answers
    // `access_token=gho_x&scope=&token_type=bearer`, and response.json() throws.
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "gho_token" }));
    await exchangeCode(config, "the-code");
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("treats GitHub's 200-with-an-error-body as a failure", async () => {
    // GitHub answers a bad code with HTTP 200 and {"error":"bad_verification_code"}.
    // Checking response.ok alone accepts it and returns undefined as the token.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "bad_verification_code", error_description: "expired" })
    );
    await expect(exchangeCode(config, "stale")).rejects.toThrow(GitHubAuthError);
  });

  it("fails rather than returning undefined when the body has no token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(exchangeCode(config, "the-code")).rejects.toThrow(GitHubAuthError);
  });

  it("fails on a non-200", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(exchangeCode(config, "the-code")).rejects.toThrow(GitHubAuthError);
  });
});

describe("resolveUserId", () => {
  it("returns the NUMERIC id as a string, never the login", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 583231, login: "octocat" }));
    expect(await resolveUserId("gho_token")).toBe("583231");
  });

  it("sends a User-Agent, which the GitHub API requires", async () => {
    // GitHub rejects API requests with no User-Agent with a 403, and the error
    // body does not obviously say so.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, login: "x" }));
    await resolveUserId("gho_token");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers((init as RequestInit).headers).get("user-agent")).toBeTruthy();
  });

  it("fails when the response carries no numeric id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
    await expect(resolveUserId("gho_token")).rejects.toThrow(GitHubAuthError);
  });

  it("fails on a revoked token", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));
    await expect(resolveUserId("gone")).rejects.toThrow(GitHubAuthError);
  });
});

describe("completeCallback", () => {
  it("returns only the numeric id, and NEVER the access token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_secret_token" }))
      .mockResolvedValueOnce(jsonResponse({ id: 583231, login: "octocat" }));

    const result = await completeCallback(config, "the-code");
    expect(result).toEqual({ githubUserId: "583231" });
    // The token has no further purpose. The provider examples stash it in grant
    // props, which would leave a live GitHub credential in KV.
    expect(JSON.stringify(result)).not.toContain("gho_secret_token");
    expect(Object.keys(result)).toEqual(["githubUserId"]);
  });

  it("does not resolve an identity when the exchange failed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad_verification_code" }));
    await expect(completeCallback(config, "stale")).rejects.toThrow(GitHubAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
