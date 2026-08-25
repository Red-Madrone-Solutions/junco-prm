import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * THE DISPATCH CHAIN, END TO END.
 *
 * Every other test in this project's auth suite calls a function directly.
 * That is what let the previous version ship an `isAllowedRedirect` with no
 * caller and a consent screen no route was obliged to render. These tests go
 * through `SELF.fetch`, so they exercise `src/index.ts` -> `OAuthProvider.fetch`
 * -> `defaultHandler` -> `githubHandler` exactly as a browser would.
 *
 * The cross-site cases below are the attack the fix round exists to close: an
 * attacker starts the flow from their own server, scrapes the consent handle,
 * and gets the owner's browser to submit the approval. Nothing about that
 * requires the owner to see, let alone click, anything.
 */

const WORKER_ORIGIN = "https://prm.example.test";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

async function registerClient(clientName: string): Promise<string> {
  const response = await SELF.fetch(`${WORKER_ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

function authorizeUrl(clientId: string, state = "claude-state"): string {
  const url = new URL(`${WORKER_ORIGIN}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** What a browser would send back: every cookie the response set, name=value. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

function handleFrom(html: string): string {
  const match = html.match(/name="handle" value="([^"]+)"/);
  expect(match, "the consent page must carry a handle").not.toBeNull();
  return match![1]!;
}

/** Drives `GET /authorize` and returns what that browser now holds. */
async function startConsent(clientId: string): Promise<{ handle: string; cookie: string }> {
  const response = await SELF.fetch(authorizeUrl(clientId), { redirect: "manual" });
  expect(response.status).toBe(200);
  return { handle: handleFrom(await response.text()), cookie: cookieHeader(response) };
}

/** A same-origin form submission, headers and all, as a browser sends it. */
function approve(fields: {
  handle: string;
  cookie?: string;
  origin?: string;
  secFetchSite?: string;
}): Promise<Response> {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (fields.cookie) headers.set("cookie", fields.cookie);
  if (fields.origin) headers.set("origin", fields.origin);
  if (fields.secFetchSite) headers.set("sec-fetch-site", fields.secFetchSite);

  return SELF.fetch(`${WORKER_ORIGIN}/authorize/approve`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ handle: fields.handle }).toString(),
    redirect: "manual",
  });
}

describe("POST /register, through the dispatch chain", () => {
  it("REFUSES a redirect URI this instance does not allow, without echoing it", async () => {
    // Dynamic Client Registration is an unauthenticated write, and this is the
    // check that stops a client naming an address the attacker controls.
    // Rejecting by RETURNING a result rather than throwing is what makes it a
    // 400 invalid_client_metadata; a throw takes the library's catch and emits
    // a 500 whose description repeats the URI back to whoever sent it.
    const response = await SELF.fetch(`${WORKER_ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Definitely Claude",
        redirect_uris: ["https://evil.test/steal"],
        token_endpoint_auth_method: "none",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; error_description?: string };
    expect(body.error).toBe("invalid_client_metadata");
    expect(JSON.stringify(body)).not.toContain("evil.test");
  });
});

describe("GET /authorize, through the dispatch chain", () => {
  it("SHOWS THE CONSENT SCREEN and redirects nowhere", async () => {
    // The regression this pins: delete the /authorize GET branch and redirect
    // straight to GitHub. Every assertion that calls consentPage() directly
    // stays green through that change; the missing `location` does not.
    const clientId = await registerClient("Some Client From The Internet");
    const response = await SELF.fetch(authorizeUrl(clientId), { redirect: "manual" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("location")).toBeNull();

    const html = await response.text();
    expect(html).toContain("Some Client From The Internet");
    expect(html).toContain(CLAUDE_CALLBACK);
  });
});

describe("POST /authorize/approve, through the dispatch chain", () => {
  it("redirects to GitHub and opens a browser-bound transaction", async () => {
    const clientId = await registerClient("Claude");
    const { handle, cookie } = await startConsent(clientId);

    const response = await approve({
      handle,
      cookie,
      origin: WORKER_ORIGIN,
      secFetchSite: "same-origin",
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.host).toBe("github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(cookieHeader(response)).toContain("junco_txn=");
  });

  it("REFUSES AN APPROVAL FROM A BROWSER THAT NEVER SAW THE CONSENT SCREEN", async () => {
    // THE ATTACK, IN ONE TEST.
    //
    // The attacker issues GET /authorize from their own server - no browser
    // involved - and scrapes the handle out of the returned HTML. They then
    // serve the owner a page whose auto-submitting form posts that handle to
    // this Worker. A simple form post needs no preflight, and `form-action
    // 'self'` on OUR consent page says nothing about a form on theirs.
    //
    // If this returns a redirect to github.com, the owner is walked through
    // the rest of the flow without ever seeing the consent screen, and the
    // grant that comes out the far end carries the owner's GitHub id and the
    // attacker's client and PKCE challenge.
    const clientId = await registerClient("Claude");
    const scraped = await SELF.fetch(authorizeUrl(clientId), { redirect: "manual" });
    const handle = handleFrom(await scraped.text());

    // The owner's browser holds no cookie for this flow, and a cross-site form
    // post sends none it might hold for another.
    const response = await approve({ handle });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("REFUSES a handle from one browser's consent approved with another's cookie", async () => {
    // The variant that survives if the cookie is checked for validity rather
    // than for belonging to THIS pending record: the attacker holds a real
    // consent cookie, because they issued a real /authorize themselves.
    const clientId = await registerClient("Claude");
    const mine = await startConsent(clientId);
    const theirs = await startConsent(clientId);

    const response = await approve({
      handle: theirs.handle,
      cookie: mine.cookie,
      origin: WORKER_ORIGIN,
      secFetchSite: "same-origin",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("REFUSES an approval whose Origin is not this Worker", async () => {
    const clientId = await registerClient("Claude");
    const { handle, cookie } = await startConsent(clientId);

    const response = await approve({ handle, cookie, origin: "https://evil.test" });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("REFUSES an approval whose Sec-Fetch-Site is not same-origin", async () => {
    const clientId = await registerClient("Claude");
    const { handle, cookie } = await startConsent(clientId);

    const response = await approve({ handle, cookie, secFetchSite: "cross-site" });

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("GET /callback, through the dispatch chain", () => {
  it("REFUSES a state replayed without the transaction cookie", async () => {
    // The attacker's other position: they hold the callback URL but not the
    // cookie, because the cookie is in the browser that approved.
    const clientId = await registerClient("Claude");
    const { handle, cookie } = await startConsent(clientId);
    const approved = await approve({
      handle,
      cookie,
      origin: WORKER_ORIGIN,
      secFetchSite: "same-origin",
    });
    const state = new URL(approved.headers.get("location")!).searchParams.get("state")!;

    const response = await SELF.fetch(
      `${WORKER_ORIGIN}/callback?code=whatever&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );

    expect(response.status).toBe(400);
  });
});
