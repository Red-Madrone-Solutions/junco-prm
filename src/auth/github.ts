import type { Config } from "../config";

/**
 * ALL GitHub-specific code lives in this file.
 *
 * There is deliberately no identity-provider interface. The spec considered one
 * and rejected it: with GitHub as the only provider, a seam would be an
 * interface with one implementation, written against a second implementation
 * that may never exist. If a second provider is ever added, the interface gets
 * extracted then, against two real cases rather than one real and one imagined.
 */

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN = "https://github.com/login/oauth/access_token";
const USER = "https://api.github.com/user";

/** GitHub's API rejects requests with no User-Agent with a 403 that does not say so. */
const USER_AGENT = "junco-prm";

export type GitHubAuthErrorReason =
  | "exchange_http"
  | "exchange_refused"
  | "exchange_empty"
  | "identity_http"
  | "identity_empty";

export class GitHubAuthError extends Error {
  constructor(
    message: string,
    public readonly reason: GitHubAuthErrorReason
  ) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/**
 * NO SCOPE PARAMETER. Not an empty one - absent.
 *
 * /user returns the numeric id with an unscoped token, so asking for read:user
 * buys nothing and costs a wider consent screen shown to exactly the stranger
 * this project is trying not to lose.
 */
export function authorizeUrl(config: Config, callbackUrl: string, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(config: Config, code: string): Promise<string> {
  const response = await fetch(ACCESS_TOKEN, {
    method: "POST",
    headers: {
      // Without this, GitHub answers form-encoded and .json() throws.
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new GitHubAuthError(`token exchange returned ${response.status}`, "exchange_http");
  }

  // GitHub answers a bad or expired code with HTTP 200 and an error body.
  // Checking response.ok alone accepts it and hands back undefined as a token.
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (body.error) {
    throw new GitHubAuthError(`token exchange refused: ${body.error}`, "exchange_refused");
  }
  if (!body.access_token) {
    throw new GitHubAuthError("token exchange returned no access_token", "exchange_empty");
  }
  return body.access_token;
}

/**
 * The NUMERIC id, as a string. Never `login`.
 *
 * GitHub's /user response carries both. A username can be changed and the old
 * one re-registered by someone else, so reading it here would put an account
 * takeover into the one function that decides who the owner is.
 */
export async function resolveUserId(accessToken: string): Promise<string> {
  const response = await fetch(USER, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new GitHubAuthError(`/user returned ${response.status}`, "identity_http");
  }

  const body = (await response.json()) as { id?: number; login?: string };
  if (typeof body.id !== "number") {
    throw new GitHubAuthError("/user returned no numeric id", "identity_empty");
  }
  return String(body.id);
}

/**
 * THE WHOLE FLOW, and the reason it is one function rather than two calls at
 * the call site: the access token never escapes this scope.
 *
 * It goes in, a numeric id comes out, and the token is never returned, stored,
 * or logged. Cloudflare's workers-oauth-provider examples stash upstream tokens
 * in grant props, so an implementer following the template ends up with the
 * owner's live GitHub credential sitting in KV - on an instance whose entire
 * security argument is one environment variable.
 */
export async function completeCallback(
  config: Config,
  code: string
): Promise<{ githubUserId: string }> {
  const accessToken = await exchangeCode(config, code);
  const githubUserId = await resolveUserId(accessToken);
  // `accessToken` goes out of scope here and is never persisted anywhere.
  return { githubUserId };
}
