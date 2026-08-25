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
 *   2. A cookie set when the flow starts binds the transaction to the browser
 *      that started it. The attacker's cookie is in the attacker's browser, so
 *      the owner arrives without it and is refused.
 *
 * Signing the state instead would NOT be sufficient. A signature proves this
 * Worker minted that state; it says nothing about which browser started the
 * flow, and an attacker gets a validly signed state just by starting a real one.
 */

const TTL_SECONDS = 600;
const COOKIE_NAME = "junco_txn";

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
    `${COOKIE_NAME}=${secret}; Path=/; Max-Age=${TTL_SECONDS}; ` +
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
  const presented = readCookie(request, COOKIE_NAME);
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
