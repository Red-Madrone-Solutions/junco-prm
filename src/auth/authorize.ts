import type { Config } from "../config";
import { logAuthFailure } from "../log";

export class NotOwnerError extends Error {
  constructor(public readonly reason: "no_props" | "not_owner") {
    super("this instance serves exactly one account, and it is not this one");
    this.name = "NotOwnerError";
  }
}

/**
 * THE ONE CHECK STANDING BETWEEN A STRANGER AND THE DATABASE.
 *
 * Called on EVERY MCP request, not only at sign-in. workers-oauth-provider
 * validates its own issued bearer token and explicitly leaves authorization to
 * the handler, so a handler that trusts a valid token has skipped this
 * entirely - and a valid token belonging to the wrong GitHub account is exactly
 * the case the spec names as non-negotiable to test.
 *
 * It compares against `config.ownerGithubUserId`, read fresh from the
 * environment on this request, rather than against anything stored alongside
 * the grant. That is what makes revocation-by-allowlist-change IMMEDIATE:
 * changing the variable and redeploying invalidates every existing grant on the
 * next request, because every existing grant carries the old id. Deleting the
 * grant from KV would work eventually - KV is eventually consistent and the
 * spec notes a deletion can take a minute or more to propagate.
 *
 * It never calls GitHub. The numeric id was written into props at consent time.
 */
export function assertOwner(config: Config, props: unknown, requestId: string): string {
  // Every non-conforming shape is a refusal. The fail-open to avoid is
  // `if (id && id !== owner) throw`, which lets a grant with no props through.
  const presented =
    props !== null &&
    typeof props === "object" &&
    !Array.isArray(props) &&
    typeof (props as { githubUserId?: unknown }).githubUserId === "string"
      ? (props as { githubUserId: string }).githubUserId
      : null;

  if (presented === null) {
    logAuthFailure({ requestId, presentedUserId: null, reason: "no_props" });
    throw new NotOwnerError("no_props");
  }

  // Exact string equality. No trim, no coercion: props round-trip through JSON
  // in KV, and an id that arrives as a number or with whitespace means the
  // write path changed. That should be noticed, not smoothed over.
  if (presented !== config.ownerGithubUserId) {
    // The one identity exception to the logging rule. A rejected identity is
    // the only signal that someone is probing the instance, and a numeric
    // GitHub id is public information about a public account.
    logAuthFailure({ requestId, presentedUserId: presented, reason: "not_owner" });
    throw new NotOwnerError("not_owner");
  }

  return presented;
}
