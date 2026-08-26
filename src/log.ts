/**
 * THE ONLY MODULE IN THIS PROJECT THAT CALLS console.
 *
 * The spec's rule: logs carry tool name, duration, outcome, and a request id.
 * They never carry a name, note text, organization, contact detail, or token.
 * Observability is enabled on the deployed Worker, so these lines are readable
 * from the Cloudflare dashboard - and the whole reason that is safe is this file.
 *
 * ENFORCEMENT IS THE SIGNATURES. Every function here takes structured fields
 * and none takes free text, so there is nothing to interpolate a person's name
 * into. Do not add a `message: string` parameter to anything in this module.
 * Plan 1's verification step greps `src/` for `console.` and expects to find
 * only this file.
 */

export function newRequestId(): string {
  return crypto.randomUUID();
}

function emit(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

export function logToolCall(fields: {
  requestId: string;
  tool: string;
  durationMs: number;
  outcome: "ok" | "error";
  /** One of plan 1's seven ToolError codes, when the outcome is an error. */
  code?: string;
}): void {
  emit({
    event: "tool_call",
    request_id: fields.requestId,
    tool: fields.tool,
    duration_ms: fields.durationMs,
    outcome: fields.outcome,
    code: fields.code ?? null,
  });
}

/**
 * THE ONE IDENTITY EXCEPTION, and it is deliberate.
 *
 * A rejected identity is the only signal that someone is probing the instance,
 * so it is logged with the numeric GitHub user id that was presented. That id
 * is public information about a public account, and it is not PRM content.
 *
 * The exception is exactly this wide. Nothing else in this module records who
 * anyone is.
 */
export function logAuthFailure(fields: {
  requestId: string;
  /** Null when the request carried no resolvable identity at all. */
  presentedUserId: string | null;
  reason: "no_token" | "invalid_token" | "not_owner" | "no_props";
}): void {
  emit({
    event: "auth_failure",
    request_id: fields.requestId,
    presented_user_id: fields.presentedUserId,
    reason: fields.reason,
  });
}

export function logRequest(fields: {
  requestId: string;
  method: string;
  /** The pathname ONLY. A query string is stripped here, not merely
   *  documented away: an authorize URL's query carries state and a
   *  redirect_uri, and a log an operator might paste into a support thread
   *  should not carry either, regardless of what the caller passed in. */
  path: string;
  status: number;
  durationMs: number;
}): void {
  const pathname = fields.path.split("?")[0]!;
  emit({
    event: "request",
    request_id: fields.requestId,
    method: fields.method,
    path: pathname,
    status: fields.status,
    duration_ms: fields.durationMs,
  });
}
