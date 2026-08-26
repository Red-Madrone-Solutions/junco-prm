/**
 * The Workers rate-limiting binding.
 *
 * `period` accepts only 10 or 60 seconds - those are the only two values the
 * binding takes, and the limit below is expressed against the one chosen in
 * wrangler.jsonc.
 *
 * Cloudflare describes this as permissive and eventually consistent rather than
 * exact. It protects quota, not correctness, and this file does not pretend
 * otherwise.
 */
/**
 * Two buckets. `/mcp` carries the owner's real tool calls and gets a generous
 * ceiling; the OAuth and health routes carry no legitimate volume at all.
 */
export const PUBLIC_LIMIT = 60;
export const MCP_LIMIT = 600;

export async function checkRateLimit(
  env: Env,
  request: Request,
  bucket: "public" | "mcp" = "public"
): Promise<boolean> {
  const limiter = bucket === "mcp" ? env.MCP_RATE_LIMITER : env.RATE_LIMITER;
  if (!limiter) return true; // fail open - see below

  try {
    // The bucket is in the key as well as in the binding, so a client cannot
    // spend the cheap bucket's allowance against the expensive one.
    const { success } = await limiter.limit({ key: `${bucket}:${clientKey(request)}` });
    return success;
  } catch {
    // FAIL OPEN, deliberately, and against the grain of everything else here.
    // A limiter outage should degrade the instance, not take it down: the spec
    // frames this as quota protection, and refusing every request to protect
    // quota is worse than the quota being spent.
    return true;
  }
}

function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export function rateLimitedResponse(requestId: string): Response {
  return new Response(JSON.stringify({ error: "rate_limited", request_id: requestId }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60" },
  });
}
