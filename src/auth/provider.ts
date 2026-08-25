import OAuthProvider, { type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Config } from "../config";
import { logAuthFailure } from "../log";
import { consentPage } from "./consent";
import { authorizeUrl, completeCallback, GitHubAuthError } from "./github";
import { beginTransaction, consumeTransaction, TransactionError } from "./transaction";

/**
 * THE ONLY THING EVER WRITTEN INTO A GRANT.
 *
 * Props are persisted in KV for the life of the grant, and reach the API
 * handler as `ctx.props`. The numeric GitHub user id is all that is needed to
 * authorize a request, so it is all that is stored: no access token, no
 * username, no email.
 *
 * Declared as a named interface with one field so adding a second is a visible
 * edit to a type rather than an extra key in an object literal in a callback.
 */
export interface GrantProps {
  githubUserId: string;
}

export function propsFor(githubUserId: string): GrantProps {
  return { githubUserId };
}

/**
 * A handler with `fetch` required, matching what workers-oauth-provider's
 * `apiHandler` and `defaultHandler` options actually accept. The workers-types
 * `ExportedHandler` declares `fetch` as optional, which the library's
 * `ExportedHandlerWithFetch` does not, so passing a plain `ExportedHandler`
 * here fails to typecheck.
 */
export type FetchHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

/**
 * EXACT URIs, not hosts.
 *
 * The previous version matched on hostname, so any path on claude.ai was
 * acceptable. The spec says Anthropic's documented callback, and this is the
 * value that decides where an authorization code gets delivered - the right
 * cost for changing it is a reviewed edit, not a silent match.
 */
export const ALLOWED_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * ACTUALLY CALLED, from `clientRegistrationCallback` below.
 *
 * The previous version exported this, unit-tested it thoroughly, and never
 * invoked it from anywhere - it was passed to an `allowedRedirectUriHosts`
 * option that does not exist in this library, so the entire redirect defense
 * was decorative. Dynamic Client Registration is an unauthenticated write, and
 * without this check a registration can point an authorization code anywhere.
 */
export function isAllowedRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // The native-app loopback exception: http to a loopback host and nowhere
  // else. Desktop and inspector clients need it. Any port, any path - the
  // address is unreachable from outside the machine, which is the protection.
  if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return true;

  return (ALLOWED_REDIRECT_URIS as readonly string[]).includes(value);
}

/**
 * One year. See docs/MEASUREMENTS.md and the note in the decisions section.
 *
 * NOTE THE OPTION NAME. The library's option is `clientRegistrationTTL`, and
 * an earlier draft passed `clientRegistrationTtlSeconds`, which does not
 * exist - so the argued-for value did nothing and the library's own 90-day
 * default applied.
 */
export const CLIENT_REGISTRATION_TTL_SECONDS = 365 * 24 * 60 * 60;

export function buildProvider(config: Config, apiHandler: FetchHandler) {
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler,

    // The provider serves these itself, which is why the rate limiter in Task 8
    // wraps the provider rather than sitting behind it.
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",

    defaultHandler: githubHandler(config),

    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,

    /**
     * WHERE THE REDIRECT POLICY ACTUALLY LIVES. This is a real option; the one
     * an earlier draft used was not.
     */
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0) {
        throw new Error("redirect_uris is required");
      }
      for (const uri of uris) {
        if (typeof uri !== "string" || !isAllowedRedirect(uri)) {
          throw new Error(`redirect_uri not permitted on this instance: ${String(uri)}`);
        }
      }
    },
  });
}

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * The bridge between the two OAuth roles, and the place the takeover lived.
 *
 * Four routes, and the ordering of the checks in each is the security:
 *
 *   GET  /authorize          parse, then SHOW CONSENT. No redirect yet.
 *   POST /authorize/approve  open a bound transaction, then redirect to GitHub.
 *   GET  /callback           consume the transaction, resolve identity, finish.
 *   *                        404. Never fall through to parseAuthRequest.
 */
function githubHandler(config: Config): FetchHandler {
  return {
    async fetch(request, env, _ctx) {
      const oauth = (env as OAuthEnv).OAUTH_PROVIDER;
      const url = new URL(request.url);
      // Set by src/index.ts so a failure here can be correlated with the
      // request that caused it. An earlier draft read a `rid` query
      // parameter that nothing ever set, so every auth failure logged "-".
      const requestId = request.headers.get("x-junco-request-id") ?? "-";

      // ---------------------------------------------------------- /authorize
      if (url.pathname === "/authorize" && request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);

        // Belt and braces over clientRegistrationCallback: a client registered
        // before that callback existed, or through some path it does not
        // cover, must still not receive a code at an address we do not allow.
        if (!isAllowedRedirect(authRequest.redirectUri)) {
          return new Response("redirect_uri not permitted on this instance", { status: 400 });
        }

        const client = await oauth.lookupClient(authRequest.clientId);
        // NOTHING IS REDIRECTED YET. The user sees who is asking first.
        return consentPage({
          clientName: String(client?.clientName ?? authRequest.clientId),
          redirectUri: authRequest.redirectUri,
          handle: await stashPending(env, authRequest),
          githubLoginUrl: "",
        });
      }

      // -------------------------------------------------- /authorize/approve
      if (url.pathname === "/authorize/approve" && request.method === "POST") {
        const form = await request.formData();
        const pending = String(form.get("handle") ?? "");
        const authRequest = await readPending(env, pending);
        if (!authRequest) return new Response("this approval has expired", { status: 400 });

        // The transaction opens HERE, at the moment a human approved it, and
        // the cookie goes to the browser that clicked. That is what binds the
        // rest of the flow to this person.
        const { handle, cookie } = await beginTransaction(env, authRequest);
        const callbackUrl = new URL("/callback", url.origin).toString();

        return new Response(null, {
          status: 302,
          headers: {
            location: authorizeUrl(config, callbackUrl, handle),
            "set-cookie": cookie,
          },
        });
      }

      if (url.pathname === "/authorize/deny") {
        return new Response("Cancelled. Nothing was authorized.", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      // ----------------------------------------------------------- /callback
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const handle = url.searchParams.get("state");
        if (!code || !handle) return new Response("missing code or state", { status: 400 });

        let authRequest: AuthRequest;
        try {
          // SINGLE USE AND BROWSER-BOUND. An attacker's link fails here,
          // because the cookie that matches this transaction is in the
          // attacker's browser, not the owner's.
          authRequest = await consumeTransaction(env, request, handle);
        } catch (e) {
          logAuthFailure({
            requestId,
            presentedUserId: null,
            reason: e instanceof TransactionError ? "invalid_token" : "no_props",
          });
          return new Response("this sign-in link is not valid for this browser", { status: 400 });
        }

        let githubUserId: string;
        try {
          ({ githubUserId } = await completeCallback(config, code));
        } catch (e) {
          // The REASON goes to the log, where the operator can see it. The
          // stranger who triggered it gets nothing.
          logAuthFailure({
            requestId,
            presentedUserId: null,
            reason: e instanceof GitHubAuthError ? "invalid_token" : "no_props",
          });
          return new Response("sign-in failed", { status: 401 });
        }

        // NO GRANT IS MINTED FOR A STRANGER. assertOwner in Task 6 is still the
        // real gate and still runs on every request; this stops KV filling with
        // dormant grants for anyone who finds the URL and signs in.
        if (githubUserId !== config.ownerGithubUserId) {
          logAuthFailure({ requestId, presentedUserId: githubUserId, reason: "not_owner" });
          return new Response("this instance serves exactly one account", { status: 403 });
        }

        const { redirectTo } = await oauth.completeAuthorization({
          request: authRequest,
          userId: githubUserId,
          metadata: {},
          scope: [],
          props: propsFor(githubUserId),
        });
        return Response.redirect(redirectTo, 302);
      }

      // 404 EVERYTHING ELSE. Never fall through to parseAuthRequest, so a
      // browser requesting /favicon.ico does not get bounced to GitHub.
      return new Response("not found", { status: 404 });
    },
  };
}

/**
 * The consent page needs somewhere to keep the parsed request between rendering
 * and the approval POST. Short-lived, and NOT the bound transaction - that only
 * opens once a human has actually approved, so an unapproved page leaves no
 * cookie anywhere.
 */
async function stashPending(env: Env, authRequest: AuthRequest): Promise<string> {
  const handle = crypto.randomUUID();
  await env.OAUTH_KV.put(`pending:${handle}`, JSON.stringify(authRequest), {
    expirationTtl: 600,
  });
  return handle;
}

async function readPending(env: Env, handle: string): Promise<AuthRequest | null> {
  if (!handle) return null;
  const raw = await env.OAUTH_KV.get(`pending:${handle}`);
  if (!raw) return null;
  await env.OAUTH_KV.delete(`pending:${handle}`);
  return JSON.parse(raw) as AuthRequest;
}
