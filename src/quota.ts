/**
 * THE QUOTA FLOOR, and a sibling of the fail-closed floor in `config.ts`.
 *
 * Cloudflare's bindings throw when an account's daily allowance runs out. The
 * throw happens inside `workers-oauth-provider`, on the KV read that validates
 * every token, so nothing this project wrote is on the stack and nothing
 * catches it. The exception escapes the Worker, Cloudflare substitutes its own
 * page, and the caller receives:
 *
 *     Error 1101: Worker threw exception
 *     A Worker script configured by the website owner threw an unhandled
 *     exception. The site owner must fix the Worker script.
 *
 * Observed live on 2026-08-27 at 22:05 UTC:
 *     "message": "KV get() limit exceeded for the day."
 *     "stack":   "at OAuthProviderImpl.handleApiRequest (index.js:10186:38)"
 *
 * That page is wrong in every part a reader would act on. The script is not
 * broken, the owner has nothing to fix, and the one fact that matters - that
 * the allowance resets at midnight UTC - appears nowhere.
 *
 * `config.ts` already answers this shape of problem for a missing variable:
 * 503 rather than 500, because the instance is not broken, and a body naming
 * what is wrong so an operator gets the answer from curl instead of from
 * `wrangler tail`. A spent allowance is the same category and gets the same
 * treatment.
 */

/**
 * Cloudflare's wording, verified against a real KV exhaustion: "KV get() limit
 * exceeded for the day." The same shape covers put, delete, and list, and the
 * daily-limit phrasing is what distinguishes an allowance from a genuine
 * fault.
 *
 * Matched narrowly ON PURPOSE. A broad match on "limit" would swallow real
 * bugs - a value over the 25 MiB KV ceiling, a row over D1's cap - and report
 * them as "come back tomorrow", which is the worst possible advice for a
 * defect that will still be there tomorrow.
 */
const DAILY_LIMIT = /limit exceeded for the day/i;

export function isDailyQuotaError(e: unknown): boolean {
  return e instanceof Error && DAILY_LIMIT.test(e.message);
}

/**
 * Names the exhausted operation, never the account, and states when the
 * allowance returns. The reset is midnight UTC, which is what Cloudflare's own
 * usage alerts quote, so an operator comparing the two sees the same number.
 *
 * `Retry-After` is seconds rather than a date because a client that honours it
 * at all honours the delta form, and because a date invites a client to parse
 * a timezone this project would then have to be right about.
 */
export function quotaErrorResponse(e: unknown, requestId: string, now: Date): Response {
  const resetsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
  const retryAfter = Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000));

  return new Response(
    JSON.stringify(
      {
        error: "quota_exhausted",
        reason:
          e instanceof Error ? e.message : "a daily Cloudflare allowance for this account is spent",
        resets_at: resetsAt.toISOString(),
        next: "retry after the reset, or raise the allowance on the Cloudflare Workers Paid plan",
        request_id: requestId,
      },
      null,
      2
    ),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
    }
  );
}
