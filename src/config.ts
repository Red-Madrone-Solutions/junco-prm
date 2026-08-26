/**
 * THE FAIL-CLOSED FLOOR.
 *
 * Called at the top of the fetch handler, before any route dispatch. If it
 * throws, the Worker serves a 503 and nothing else - no OAuth routes, no
 * health, no tools.
 *
 * The spec's reasoning: the worst plausible outcome of a careless deploy is a
 * stranger's contact list on the open internet, and that state must be
 * unreachable BY OMISSION rather than by a check someone remembered to write.
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    /** Every variable that is missing or invalid, not just the first. */
    public readonly missing: string[]
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  githubClientId: string;
  githubClientSecret: string;
  cookieKey: string;
  ownerGithubUserId: string;
  ownerTimezone: string;
}

/** Present-but-empty fails like absent: a secret set with a stray newline is unset. */
function present(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRealTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Env): Config {
  const missing: string[] = [];
  const notes: string[] = [];

  const githubClientId = present(env.GITHUB_CLIENT_ID);
  if (!githubClientId) missing.push("GITHUB_CLIENT_ID");

  const githubClientSecret = present(env.GITHUB_CLIENT_SECRET);
  if (!githubClientSecret) missing.push("GITHUB_CLIENT_SECRET");

  const cookieKey = present(env.COOKIE_ENCRYPTION_KEY);
  if (!cookieKey) {
    missing.push("COOKIE_ENCRYPTION_KEY");
  } else if (cookieKey.length < 64) {
    // 32 bytes as hex. Never echo the value itself - this message ends up in
    // a 503 body.
    missing.push("COOKIE_ENCRYPTION_KEY");
    notes.push("COOKIE_ENCRYPTION_KEY must be at least 32 bytes of hex (64 characters)");
  }

  const ownerGithubUserId = present(env.OWNER_GITHUB_USER_ID);
  if (!ownerGithubUserId) {
    missing.push("OWNER_GITHUB_USER_ID");
  } else if (!/^\d+$/.test(ownerGithubUserId)) {
    missing.push("OWNER_GITHUB_USER_ID");
    notes.push(
      "OWNER_GITHUB_USER_ID must be numeric - it is a GitHub user id, not a username. " +
        "Resolve it from https://api.github.com/users/<username>"
    );
  }

  const ownerTimezone = present(env.OWNER_TIMEZONE);
  if (!ownerTimezone) {
    missing.push("OWNER_TIMEZONE");
  } else if (!isRealTimezone(ownerTimezone)) {
    missing.push("OWNER_TIMEZONE");
    notes.push(`OWNER_TIMEZONE is not a recognized IANA zone: ${ownerTimezone}`);
  }

  // The bindings, checked the same way. A KV namespace whose id was never
  // written into wrangler.jsonc arrives as undefined, and the failure without
  // this check is a TypeError deep inside the OAuth provider.
  if (!env.DB) missing.push("DB (D1 binding)");
  if (!env.OAUTH_KV) missing.push("OAUTH_KV (KV binding)");

  if (missing.length > 0) {
    const detail = notes.length > 0 ? ` ${notes.join("; ")}` : "";
    throw new ConfigError(
      `Junco PRM is not configured. Missing or invalid: ${missing.join(", ")}.${detail}`,
      missing
    );
  }

  return {
    githubClientId: githubClientId!,
    githubClientSecret: githubClientSecret!,
    cookieKey: cookieKey!,
    ownerGithubUserId: ownerGithubUserId!,
    ownerTimezone: ownerTimezone!,
  };
}

/**
 * 503, not 500: the instance is not broken, it is not finished being set up,
 * and a retry after configuration will succeed.
 *
 * The body names what is missing. That is a deliberate trade and worth stating:
 * a stranger who finds the URL learns that a Junco PRM instance exists here and
 * is unconfigured, which is close to what a bare 503 tells them anyway. What
 * they do NOT learn is any value, and an unconfigured instance holds no data to
 * protect. Against that, an operator debugging their own deploy gets the answer
 * from curl instead of from `wrangler tail`.
 */
export function configErrorResponse(e: ConfigError, requestId: string): Response {
  return new Response(
    JSON.stringify({ error: "not_configured", reason: e.message, request_id: requestId }, null, 2),
    { status: 503, headers: { "content-type": "application/json" } }
  );
}
