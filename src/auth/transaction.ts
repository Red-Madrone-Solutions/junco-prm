import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

/**
 * THE PENDING AUTHORIZATION, HELD SERVER-SIDE AND BOUND TO ONE BROWSER.
 *
 * This module exists because of a specific attack. The previous design put the
 * auth request itself into GitHub's `state` parameter as base64url JSON and
 * trusted it on the way back. An attacker could start a real flow, capture the
 * resulting GitHub URL, send it to the owner, and have the owner's GitHub
 * identity complete the ATTACKER's authorization - handing them a token that
 * every downstream ownership check would accept.
 *
 * Two properties defeat that, and both are needed:
 *
 *   1. Only an opaque random handle travels through GitHub. The auth request is
 *      in KV, so nothing an attacker can craft describes a different one.
 *   2. A cookie binds each server-side record to one browser, so a browser that
 *      did not receive the cookie cannot use the record.
 *
 * THERE ARE TWO RECORDS AND TWO COOKIES, and the reason is a variant of the
 * same attack. A first version of this module bound only the transaction, which
 * opens at the approval POST. That left the pending consent record - created by
 * an unauthenticated GET that any party can issue, browser or not - bound to
 * nobody. An attacker could issue that GET from their own server, scrape the
 * handle out of the returned HTML, and get the owner's browser to submit the
 * approval from a page of their own. The owner never saw the consent screen,
 * and the cookie that then arrived was one this Worker had just placed in the
 * owner's browser itself, so every check downstream reported success.
 *
 *   - `beginConsent` / `consumeConsent` bind the pending record to the browser
 *     the consent screen was rendered to. Its cookie is SameSite=Strict: the
 *     only request that reads it is a form submission from our own page.
 *   - `beginTransaction` / `consumeTransaction` bind the approved request to
 *     the browser that approved it, and carry that binding across the round
 *     trip to GitHub. Its cookie is SameSite=Lax, because the request that
 *     reads it is a top-level navigation arriving from github.com and Strict
 *     would drop it on exactly the request that needs it.
 *
 * Signing the state instead would NOT be sufficient. A signature proves this
 * Worker minted that state; it says nothing about which browser started the
 * flow, and an attacker gets a validly signed state just by starting a real one.
 *
 * THE CONSENT COOKIE HOLDS MORE THAN ONE SECRET, bounded and rotating, because
 * one browser can have more than one `GET /authorize` pending at once - Claude
 * on the web and Claude on the desktop, started minutes apart, are the same
 * browser and each opens its own consent page. A cookie that held only the
 * newest secret would make the older page's approval fail with no way to
 * recover but reloading it. See `beginConsent` and `consumeConsent` below.
 */

const TTL_SECONDS = 600;
const TXN_COOKIE_NAME = "junco_txn";
const CONSENT_COOKIE_NAME = "junco_consent";

// The consent cookie holds up to this many secrets at once, newest first,
// joined by a delimiter that cannot collide with a secret's own characters -
// every secret is base64url of 32 random bytes, so it never contains ".".
// More than this many authorization flows open at once in one browser, on a
// single-owner PRM, is not a real case; the cap is what keeps the cookie
// bounded without needing a cleanup path of its own.
const MAX_CONSENT_SECRETS = 3;
const CONSENT_SECRET_DELIMITER = ".";

function randomHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class TransactionError extends Error {
  constructor(public readonly reason: "no_cookie" | "mismatch" | "unknown" | "expired") {
    super("this sign-in link is not valid for this browser");
    this.name = "TransactionError";
  }
}

export class ConsentError extends Error {
  constructor(public readonly reason: "no_cookie" | "mismatch" | "unknown") {
    // Two messages, and the split is deliberate. "unknown" covers an expired
    // record and a forged handle alike, and it is named for the expiry because
    // that is the only one of the two a legitimate person hits - by leaving the
    // page open past the TTL - and they need to be told to start again. A
    // missing cookie and a wrong one share the other message, so neither is
    // distinguishable from outside.
    super(
      reason === "unknown"
        ? "this approval has expired"
        : "this approval is not valid for the browser that started it"
    );
    this.name = "ConsentError";
  }
}

/**
 * Opens a PENDING CONSENT: the parsed auth request, held between rendering the
 * consent screen and the approval POST, bound to the browser it is rendered to.
 *
 * The binding starts HERE and not at the approval, which is the whole point.
 * `GET /authorize` is unauthenticated and anyone can issue it, including from a
 * server with no browser at all. Whoever issues it receives this cookie; a
 * browser that was never shown the page does not have it and cannot approve.
 *
 * The cookie MINTED HERE MAY ALREADY HOLD SECRETS from other pending consents
 * in the same browser - a second `GET /authorize` before the first is approved
 * or expires, for instance two authorization attempts started minutes apart.
 * The new secret is added to the front rather than replacing what is there, so
 * an older, still-open consent page does not stop working.
 */
export async function beginConsent(
  env: Env,
  request: Request,
  authRequest: AuthRequest
): Promise<{ handle: string; cookie: string }> {
  const handle = randomHandle();
  const secret = randomHandle();

  await env.OAUTH_KV.put(`pending:${handle}`, JSON.stringify({ authRequest, secret }), {
    expirationTtl: TTL_SECONDS,
  });

  const existing = readCookie(request, CONSENT_COOKIE_NAME);
  const priorSecrets = existing ? existing.split(CONSENT_SECRET_DELIMITER) : [];
  const secrets = [secret, ...priorSecrets].slice(0, MAX_CONSENT_SECRETS);

  return { handle, cookie: consentCookieHeader(secrets) };
}

/**
 * Sent with the redirect to GitHub. The pending record is consumed by then, so
 * the secret that bound it has no further use and should not sit in the browser
 * for the rest of its ten minutes.
 */
export const CONSENT_COOKIE_CLEARED =
  `${CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/** Builds the Set-Cookie header for a given list of consent secrets, newest
 * first. An empty list clears the cookie rather than sending an empty value,
 * so a browser with no pending consents left does not keep carrying it. */
function consentCookieHeader(secrets: string[]): string {
  if (secrets.length === 0) return CONSENT_COOKIE_CLEARED;

  return (
    `${CONSENT_COOKIE_NAME}=${secrets.join(CONSENT_SECRET_DELIMITER)}; Path=/; ` +
    `Max-Age=${TTL_SECONDS}; ` +
    // SameSite=Strict, unlike the transaction cookie below. The only request
    // that reads this one is a form submission from our own consent page, which
    // is same-site; a cross-site form post carries no Strict cookie at all.
    "HttpOnly; Secure; SameSite=Strict"
  );
}

/**
 * Consumes a pending consent. SINGLE USE, and the cookie is checked before KV
 * is touched: a caller with no cookie learns nothing about whether the handle
 * it presented names a real record.
 *
 * The presented cookie may carry more than one secret - other pending consents
 * in the same browser. Every entry is compared, constant-time, and the loop
 * never stops early: stopping at the first match would leak which position in
 * the cookie matched through timing. The returned cookie carries every entry
 * that did NOT match, so the other pending consent(s) in this browser stay
 * approvable; only the caller of this function decides whether to send it.
 */
export async function consumeConsent(
  env: Env,
  request: Request,
  handle: string
): Promise<{ authRequest: AuthRequest; cookie: string }> {
  const presented = readCookie(request, CONSENT_COOKIE_NAME);
  if (!presented) throw new ConsentError("no_cookie");
  if (!handle) throw new ConsentError("unknown");

  const raw = await env.OAUTH_KV.get(`pending:${handle}`);
  if (!raw) throw new ConsentError("unknown");

  const stored = JSON.parse(raw) as { authRequest: AuthRequest; secret: string };

  // Delete BEFORE validating the secret, for the same reason consumeTransaction
  // does: a wrong-cookie attempt burns the record rather than leaving it to be
  // probed again.
  await env.OAUTH_KV.delete(`pending:${handle}`);

  const presentedSecrets = presented.split(CONSENT_SECRET_DELIMITER);
  let matched = false;
  const remaining: string[] = [];
  for (const candidate of presentedSecrets) {
    const isMatch = timingSafeEqual(stored.secret, candidate);
    matched = matched || isMatch;
    if (!isMatch) remaining.push(candidate);
  }

  if (!matched) throw new ConsentError("mismatch");

  return { authRequest: stored.authRequest, cookie: consentCookieHeader(remaining) };
}

/**
 * Opens a transaction. Returns the handle to put in `state` and the `Set-Cookie`
 * header to send with the redirect.
 *
 * The cookie value is a SECOND independent random value, not the handle. The
 * handle travels through GitHub and through the user's browser history; the
 * cookie does not. Reusing one value for both would mean anyone who saw the
 * callback URL held the binding secret too.
 */
export async function beginTransaction(
  env: Env,
  authRequest: AuthRequest
): Promise<{ handle: string; cookie: string }> {
  const handle = randomHandle();
  const secret = randomHandle();

  await env.OAUTH_KV.put(`txn:${handle}`, JSON.stringify({ authRequest, secret }), {
    expirationTtl: TTL_SECONDS,
  });

  const cookie =
    `${TXN_COOKIE_NAME}=${secret}; Path=/; Max-Age=${TTL_SECONDS}; ` +
    // HttpOnly: script cannot read it. Secure: never sent over http.
    // SameSite=Lax rather than Strict, because the callback arrives as a
    // top-level navigation FROM github.com and Strict would drop the cookie on
    // exactly the request that needs it.
    "HttpOnly; Secure; SameSite=Lax";

  return { handle, cookie };
}

/**
 * Consumes a transaction. SINGLE USE - the record is deleted before the auth
 * request is returned, so a captured callback URL cannot be replayed.
 */
export async function consumeTransaction(
  env: Env,
  request: Request,
  handle: string
): Promise<AuthRequest> {
  const presented = readCookie(request, TXN_COOKIE_NAME);
  if (!presented) throw new TransactionError("no_cookie");

  const raw = await env.OAUTH_KV.get(`txn:${handle}`);
  // Covers a forged handle, an expired one, and a replayed one alike: in every
  // case there is no record, and none of them deserves a different message.
  if (!raw) throw new TransactionError("unknown");

  const stored = JSON.parse(raw) as { authRequest: AuthRequest; secret: string };

  // Delete BEFORE validating the secret, so a wrong-cookie attempt also burns
  // the transaction. An attacker who can guess handles should not be able to
  // probe them repeatedly.
  await env.OAUTH_KV.delete(`txn:${handle}`);

  if (!timingSafeEqual(stored.secret, presented)) throw new TransactionError("mismatch");

  return stored.authRequest;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** Constant-time comparison. Both values are base64url of 32 random bytes. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
