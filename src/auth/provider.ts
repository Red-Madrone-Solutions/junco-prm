import OAuthProvider, { type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Config } from "../config";
import { logAuthFailure } from "../log";
import { consentPage } from "./consent";
import { authorizeUrl, completeCallback, GitHubAuthError } from "./github";
import {
  beginConsent,
  beginTransaction,
  ConsentError,
  consumeConsent,
  consumeTransaction,
  TransactionError,
} from "./transaction";

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
        return { code: "invalid_client_metadata", description: "redirect_uris is required" };
      }
      for (const uri of uris) {
        if (typeof uri !== "string" || !isAllowedRedirect(uri)) {
          // RETURNED, NOT THROWN, and the rejected URI is not echoed back.
          // ClientRegistrationCallbackResult in the installed .d.ts documents a
          // returned object as the way to reject, which the library turns into
          // a 400 invalid_client_metadata. A throw takes its catch instead and
          // yields a 500 whose description repeats whatever the caller sent.
          return {
            code: "invalid_client_metadata",
            description: "redirect_uri not permitted on this instance",
          };
        }
      }
      return undefined;
    },
  });
}

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * The bridge between the two OAuth roles, and the place the takeover lived.
 *
 * Four routes, and the ordering of the checks in each is the security:
 *
 *   GET  /authorize          parse, then SHOW CONSENT, bound to this browser.
 *                            No redirect yet.
 *   POST /authorize/approve  prove the same browser, then open a transaction
 *                            and redirect to GitHub.
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
        // The cookie goes out WITH THE PAGE, so the pending record belongs to
        // the browser that was shown the consent screen from the moment it
        // exists. Anyone can issue this GET, including from a server with no
        // browser; whoever does gets the cookie, and nobody else can use their
        // handle.
        const { handle, cookie } = await beginConsent(env, request, authRequest);

        // NOTHING IS REDIRECTED YET. The user sees who is asking first.
        return consentPage({
          clientName: String(client?.clientName ?? authRequest.clientId),
          clientId: authRequest.clientId,
          registeredAt: client?.registrationDate ?? null,
          redirectUri: authRequest.redirectUri,
          handle,
          setCookie: cookie,
        });
      }

      // -------------------------------------------------- /authorize/approve
      if (url.pathname === "/authorize/approve" && request.method === "POST") {
        // FIRST, AND BEFORE THE BODY IS READ: this POST must be our own form.
        //
        // `form-action 'self'` on the consent page constrains forms ON that
        // page. It says nothing about a form on somebody else's page aimed at
        // us, and a simple form post triggers no preflight, so without this an
        // attacker who scraped a handle out of an /authorize response they
        // issued themselves could have the owner's browser submit it.
        if (!isSameOriginForm(request, url.origin)) {
          logAuthFailure({ requestId, presentedUserId: null, reason: "invalid_token" });
          return new Response("this approval did not come from this site", { status: 400 });
        }

        const form = await request.formData();
        const pending = String(form.get("handle") ?? "");

        let authRequest: AuthRequest;
        let consentCookie: string;
        try {
          // AND THE CHECK THAT DOES NOT DEPEND ON A HEADER BEING SENT. The
          // cookie this compares against was set on the consent response, in
          // the browser that page was rendered to. A browser that never loaded
          // it has nothing to present, so it cannot approve on someone's behalf
          // even if both headers above are absent.
          //
          // The returned cookie carries whatever OTHER pending consents this
          // browser still holds, minus the one just consumed - not a blanket
          // clear, which would break a second, still-open consent page in the
          // same browser.
          const consumed = await consumeConsent(env, request, pending);
          authRequest = consumed.authRequest;
          consentCookie = consumed.cookie;
        } catch (e) {
          logAuthFailure({
            requestId,
            presentedUserId: null,
            reason: e instanceof ConsentError ? "invalid_token" : "no_props",
          });
          return new Response(
            e instanceof ConsentError ? e.message : "this approval could not be processed",
            { status: 400 }
          );
        }

        // The transaction opens HERE, at the moment a human approved it, and it
        // carries the binding across the round trip to GitHub - which the
        // consent cookie cannot, being SameSite=Strict.
        const { handle, cookie } = await beginTransaction(env, authRequest);
        const callbackUrl = new URL("/callback", url.origin).toString();

        const headers = new Headers({
          location: authorizeUrl(config, callbackUrl, handle),
        });
        headers.append("set-cookie", cookie);
        headers.append("set-cookie", consentCookie);
        return new Response(null, { status: 302, headers });
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
 * Two headers a browser sets and a page cannot forge.
 *
 * `Sec-Fetch-Site` is `same-origin` when our own consent page submits the form
 * and `cross-site` when somebody else's does. `Origin` is sent on every form
 * POST and names the page the form was on.
 *
 * NEITHER IS TREATED AS REQUIRED, and that is deliberate. Both are absent from
 * a request made by something that is not a browser, so demanding them would
 * refuse legitimate non-browser callers while proving nothing about the ones
 * that matter. A header that is present and wrong is evidence; a header that is
 * missing is not, and the consent cookie is what carries the property there.
 */
function isSameOriginForm(request: Request, origin: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;

  const declaredOrigin = request.headers.get("origin");
  if (declaredOrigin !== null && declaredOrigin !== origin) return false;

  return true;
}
