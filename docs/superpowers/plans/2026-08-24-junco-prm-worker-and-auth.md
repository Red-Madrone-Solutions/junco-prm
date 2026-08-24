# Junco PRM Worker, MCP Transport, and GitHub OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the tool library from plan 1 into a deployed Cloudflare Worker that Claude can connect to as a custom MCP connector, authenticated by GitHub OAuth and authorized to exactly one person.

**Architecture:** A Worker whose `fetch` handler is `workers-oauth-provider`, wrapped by a rate limiter. The provider serves `/authorize`, `/token`, and `/register` itself and hands authenticated requests to an MCP handler that iterates plan 1's `TOOLS` registry. The Worker plays two OAuth roles at once - an OAuth **server** to Claude, and an OAuth **client** to GitHub - and keeping them separate is the organizing idea of this plan. Transport is stateless Streamable HTTP with no Durable Object. Authorization is one allowlisted numeric GitHub user id, compared on every request against a value stored in the grant at consent time.

**Tech Stack:** TypeScript, Cloudflare Workers (workerd), `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk`, Workers KV, D1, Wrangler 4.x, Vitest with `@cloudflare/vitest-pool-workers`, Node 26 / npm 11.

**Spec:** `docs/superpowers/specs/2026-08-20-junco-prm-design.md`

**Plan 1:** `docs/superpowers/plans/2026-08-20-junco-prm-data-layer.md`

**Written 2026-08-24**, against the fifth revision of the spec and the 2026-08-24 reconciliation of plan 1. It is written before plan 1 is implemented, deliberately: plan 2 depends on plan 1's registry **contract**, which is settled, not on its working code, and writing it now gives it a chance to send findings back up the way plan 1's review did.

## Scope

This is plan 2 of 3 for spec phase 1.

- **Plan 1** - schema, migrations, FTS5, and the full tool module, tested against local D1. Written and reconciled; not yet implemented.
- **Plan 2 (this document)** - Worker entrypoint, configuration and fail-closed startup, structured logging, `/health`, GitHub OAuth, `workers-oauth-provider`, per-request owner authorization, MCP over stateless Streamable HTTP, and rate limiting the unauthenticated surface.
- **Plan 3** - `docs/DEPLOY.md` runbook, `docs/UPGRADE.md`, the deploy template, the CLI durable-data export, and the tested restore.

**Plan 2's deliverable is the first thing anyone can actually use.** Plan 1 produces a library that is exercised by tests; plan 2 produces a URL that Claude connects to. That is why the last task in this plan is an authenticated end-to-end run through a real Claude client against a real deployment, and why it cannot be skipped: local tests cannot exercise Dynamic Client Registration, the consent screen, or token refresh, which is where a connector actually fails.

## What plan 2 must not do

Named up front, because each is a thing an implementer will reach for.

- **It does not touch `src/tools/`.** Plan 1's tool module is transport-agnostic and stays that way. If plan 2 needs something the registry does not expose, the fix goes in plan 1's registry, not in a special case here.
- **It does not write a second tool schema anywhere.** Every tool's name, description, input schema, and MCP annotations come from `TOOLS`. A schema written twice is a schema that drifts.
- **It does not add a Durable Object.** Cloudflare's `McpAgent` templates are deprecated for new servers, and stateless Streamable HTTP avoids both an extra binding and a class of session bugs.
- **It does not write the deploy runbook.** That is plan 3. Plan 2 produces a Worker that *can* be deployed and a `wrangler.jsonc` that declares what it needs; the document that walks a stranger through it comes later.

---

## Global Constraints

From the spec. Every task's requirements implicitly include this section.

- **The Worker fails closed.** If the owner allowlist variable is unset, or the GitHub client id or secret is missing, or the cookie encryption secret is missing, it refuses to serve tools at all. The worst plausible outcome of a careless deploy is a stranger's contact list on the open internet, and that state must be unreachable **by omission** rather than by a check someone remembered to write.
- **Authorization is checked on every MCP request**, against the identity bound to the presented token, and not only at sign-in. Revoking access has to mean the *next request* fails, not the next login.
- **The check reads a stored numeric id, never GitHub.** At consent time the numeric GitHub user id is written into the grant's props; each request compares that stored id against the current environment variable. Calling GitHub per request would spend a 5,000-per-hour quota on routine tool calls and add a network round trip to every one.
- **Only the numeric id is persisted; the GitHub access token is discarded** as soon as the callback has resolved the identity. Cloudflare's `workers-oauth-provider` examples stash upstream tokens in grant props, so an implementer following the template ends up with the owner's live GitHub credential sitting in KV on an instance whose entire security argument is one environment variable.
- **No GitHub scopes are requested.** `https://api.github.com/user` returns the numeric id with an unscoped token. Asking for `read:user` by reflex widens both the consent screen shown to the stranger this project is trying not to lose and the blast radius if anything leaks.
- **The owner identifier is a numeric GitHub user id, never a username.** Usernames can be changed and re-registered by someone else; the numeric id is stable for the life of the account.
- **Logs never contain PRM content.** Structured logs carry tool name, duration, outcome, and a request id. They do not carry names, note text, contact details, or tokens. **Authentication failures are the one exception and are logged with the presented numeric id**, because a rejected identity is the only signal that someone is probing the instance.
- **Every tool's name, description, input schema, and MCP annotations come from plan 1's `TOOLS` registry.** Plan 2 advertises what the registry says and adds nothing of its own.
- **Errors are the closed set of seven codes** plan 1 fixed: `invalid_input`, `invalid_id`, `not_found`, `conflict`, `confirmation_required`, `confirmation_invalid`, `limit_exceeded`. Plan 2 maps `ToolError` onto MCP tool results carrying that code, its reason, its corrective next call, and its structured details. It never invents an eighth code and never flattens one into a bare string.
- **A tool that throws is a tool result, not a protocol error.** MCP distinguishes a failed *call* from a broken *request*. A `not_found` is the former and must reach the model as content it can act on; a malformed JSON-RPC frame is the latter.
- **Timestamps and dates come from `ToolContext`,** which plan 2 builds per request from the `OWNER_TIMEZONE` variable and a real clock. Workers run in UTC, and every date-shaped guarantee in plan 1 depends on the zone being right.
- **Rate limiting wraps the OAuth provider's fetch handler,** not a tool handler. `workers-oauth-provider` serves `/authorize`, `/token`, and `/register` itself, so a limiter sitting behind it never sees the routes it exists to protect.
- **Observability is enabled in `wrangler.jsonc`,** so a deployed instance is debuggable at all. That only helps because the logging rule above makes the logs safe to read.
- **Nothing in this plan is tested only locally.** Task 9 runs against a real deployment through a real Claude client, because Dynamic Client Registration, the consent screen, and token refresh have no local equivalent.

---

## Prerequisites

This plan cannot start until three things are true. Each is a hard gate, and an agent that finds one unmet should stop rather than work around it.

1. **Plan 1 is implemented and its verification section passes.** Plan 2 imports `TOOLS` and calls it. There is no useful subset of plan 2 that can be built against a registry that does not exist.
2. **Plan 1's Task 0 has run**, and `docs/MEASUREMENTS.md` records whether a `[[ratelimits]]` binding is accepted on a free Cloudflare account. Task 8 of this plan builds one of two different things depending on that answer, and building the wrong one is a wasted task plus a failed deploy.
3. **Matt has a GitHub OAuth App registered** and its client id and secret to hand. This is a human block, it takes one browser visit, and Task 4 cannot be tested without it. The exact navigation path belongs in plan 3's runbook; what matters here is that it is an **OAuth App**, under Developer settings, and specifically **not** a GitHub App. GitHub's interface pushes the latter harder, it is a different flow with a different token model, and both strangers and agents pick it by mistake.

---

## Configuration surface

Every variable and binding this Worker reads, in one place, because a fail-closed design is only as good as its list of things to check for. Plan 3's runbook sets all of these; Task 1 validates them.

**Secrets** - set with `wrangler secret put`, never in `wrangler.jsonc`:

| Name | What it is |
|---|---|
| `GITHUB_CLIENT_SECRET` | From the GitHub OAuth App. |
| `COOKIE_ENCRYPTION_KEY` | Random 32 bytes, hex. `workers-oauth-provider` encrypts its consent cookie with it. |

**Plain variables** - in `wrangler.jsonc`, visible in the dashboard, not secret:

| Name | What it is |
|---|---|
| `GITHUB_CLIENT_ID` | From the GitHub OAuth App. Public by design; it appears in the authorize URL. |
| `OWNER_GITHUB_USER_ID` | The owner's **numeric** GitHub user id, as a string. Resolvable before deployment from `https://api.github.com/users/<username>`. |
| `OWNER_TIMEZONE` | An IANA zone, e.g. `America/Los_Angeles`. |

**Bindings:**

| Binding | What it is |
|---|---|
| `DB` | The D1 database from plan 1. |
| `OAUTH_KV` | Workers KV. Required by `workers-oauth-provider` for authorization state and issued grants. |
| `RATE_LIMITER` | The Workers rate-limiting binding, **only if Task 0 found it available on the free plan.** See Task 8. |

**`OWNER_GITHUB_USER_ID` is a plain variable rather than a secret, and that is deliberate.** It is not a credential - it is a public number anyone can look up from a username - and making it a secret would hide it from `wrangler deploy` output and the dashboard, which is exactly where an operator needs to see it when debugging why their own requests are being refused. Its secrecy was never what protects the instance; the OAuth flow is.

---

## File Structure

Plan 1 owns `src/tools/`, `src/errors.ts`, `src/ids.ts`, `src/time.ts`, `src/normalize.ts`, `src/paginate.ts`, `src/context.ts`, `src/idempotency.ts`, and `src/confirm.ts`. **Plan 2 adds files beside them and modifies exactly one:** `src/index.ts`, which plan 1 left as a stub returning 501.

**The Worker**

- `src/index.ts` - the entrypoint. Assembles the limiter, the OAuth provider, and the two handlers, and does nothing else. Replaces plan 1's stub.
- `src/config.ts` - reads and validates every variable and binding above. The fail-closed floor.
- `src/log.ts` - structured logging and the per-request id. One module, because "logs never contain PRM content" is a rule that has to be enforceable by reading one file.
- `src/health.ts` - the `/health` route.

**Authentication**

- `src/auth/github.ts` - the OAuth **client** side: the authorize redirect, the callback, state validation, the token exchange, and resolving the numeric user id. All GitHub-specific code lives here and nowhere else.
- `src/auth/provider.ts` - the OAuth **server** side: `workers-oauth-provider` configuration, the consent handler, and the Dynamic Client Registration constraints.
- `src/auth/authorize.ts` - the per-request owner check. Small, separate, and named after the one thing it does, because it is the single function standing between a stranger and the database.

**MCP**

- `src/mcp/server.ts` - builds an MCP server from plan 1's `TOOLS`, per request.
- `src/mcp/transport.ts` - stateless Streamable HTTP: request in, response out, no session state.
- `src/mcp/errors.ts` - `ToolError` to MCP tool result. The one place the seven codes cross the transport boundary.

**Rate limiting**

- `src/ratelimit.ts` - one of two implementations, chosen by Task 0's finding. Both export the same function, so `src/index.ts` does not know which it got.

**Tests**

- `tests/config.test.ts`, `tests/health.test.ts`, `tests/auth-github.test.ts`, `tests/authorize.test.ts`, `tests/mcp.test.ts`, `tests/ratelimit.test.ts`
- `tests/deployed.md` - the manual end-to-end script for Task 9. A markdown checklist rather than a test file, because it runs against a real deployment through a real client and no runner can drive it.

**There is no `src/auth/index.ts` re-exporting the other three.** A barrel file over three modules whose whole point is that they do different jobs would undo the separation this plan is organized around. `src/index.ts` imports each by name, and the import list is a readable summary of what the Worker is made of.

**The two OAuth roles are two files, and that is the organizing idea.** `provider.ts` is the Worker being an OAuth server to Claude; `github.ts` is the Worker being an OAuth client to GitHub. They share nothing but the numeric id that passes between them. Conflating them is the easiest way to design this wrong, and the file boundary is what keeps an implementer from doing it accidentally at 2am.

---

### Task 1: Configuration and fail-closed startup

**Files:**
- Create: `src/config.ts`
- Modify: `env.d.ts` - add the plan 2 bindings and variables
- Modify: `wrangler.jsonc` - add the KV binding, the plain variables, and observability
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing from plan 1 except the `DB` binding it validates.
- Produces:
  - `interface Config { githubClientId: string; githubClientSecret: string; cookieKey: string; ownerGithubUserId: string; ownerTimezone: string }`
  - `function loadConfig(env: Env): Config` - throws `ConfigError` naming every missing item at once
  - `class ConfigError extends Error { missing: string[] }`
  - `function configErrorResponse(e: ConfigError, requestId: string): Response` - a 503 that says what is wrong without saying anything useful to a stranger

**This task comes first because it is the security floor, and every task after it assumes the floor holds.** The spec's sentence is worth reading twice: the worst plausible outcome of a careless deploy is a stranger's contact list on the open internet, and that state must be unreachable **by omission** rather than by a check someone remembered to write. A config module that is called at the top of the fetch handler, before any route dispatch, is the difference between those two.

**It reports every missing item at once, not the first one.** An operator who has forgotten two secrets should learn that in one deploy, not two. This is a small thing that costs nothing to build and is genuinely unpleasant to retrofit into a validator built around early returns.

**It validates `OWNER_TIMEZONE`, not just its presence.** A typo'd zone is worse than a missing one: `Intl.DateTimeFormat` throws a `RangeError` on an invalid IANA name, so an unvalidated typo surfaces later as a crash inside `list_due` rather than as a refused deploy. Every date-shaped guarantee in plan 1 - due dates, `days_overdue`, the `today` envelope on every result - depends on this string being real.

**It validates that `OWNER_GITHUB_USER_ID` is digits.** GitHub numeric ids are integers, and the single most likely operator error is pasting a *username* into this variable. That would be a fail-open of the worst kind: the comparison in Task 6 would never match the numeric id resolved at consent time, so the owner would be locked out - which is at least loud - but an implementer "fixing" the mismatch by comparing usernames instead reintroduces exactly the attack the spec removed the username to prevent. Refusing a non-numeric value at startup makes the mistake impossible to paper over.

- [ ] **Step 1: Write the failing test `tests/config.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

/** A complete, valid environment. Each case below removes exactly one thing. */
function validEnv() {
  return {
    GITHUB_CLIENT_ID: "Iv1.abc123",
    GITHUB_CLIENT_SECRET: "shhh",
    COOKIE_ENCRYPTION_KEY: "0".repeat(64),
    OWNER_GITHUB_USER_ID: "583231",
    OWNER_TIMEZONE: "America/Los_Angeles",
  } as never;
}

describe("loadConfig", () => {
  it("returns a Config when everything is present", () => {
    const config = loadConfig(validEnv());
    expect(config.ownerGithubUserId).toBe("583231");
    expect(config.ownerTimezone).toBe("America/Los_Angeles");
  });

  for (const missing of [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "COOKIE_ENCRYPTION_KEY",
    "OWNER_GITHUB_USER_ID",
    "OWNER_TIMEZONE",
  ] as const) {
    it(`REFUSES when ${missing} is absent`, () => {
      const env = validEnv() as Record<string, string>;
      delete env[missing];
      try {
        loadConfig(env as never);
        throw new Error("should have refused");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).missing).toContain(missing);
      }
    });

    it(`REFUSES when ${missing} is an empty string`, () => {
      // A secret that was `wrangler secret put` with an accidental newline or
      // nothing at all arrives as "". Present-but-empty must fail like absent.
      const env = validEnv() as Record<string, string>;
      env[missing] = "   ";
      expect(() => loadConfig(env as never)).toThrow(ConfigError);
    });
  }

  it("names EVERY missing item at once, not just the first", () => {
    // An operator who forgot two secrets should learn that in one deploy.
    const env = validEnv() as Record<string, string>;
    delete env.GITHUB_CLIENT_SECRET;
    delete env.OWNER_TIMEZONE;
    try {
      loadConfig(env as never);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ConfigError).missing.sort()).toEqual([
        "GITHUB_CLIENT_SECRET",
        "OWNER_TIMEZONE",
      ]);
    }
  });

  it("REFUSES a non-numeric OWNER_GITHUB_USER_ID", () => {
    // The likeliest operator error is pasting a username. Refusing it here
    // makes it impossible to "fix" later by comparing usernames instead,
    // which would reintroduce the takeover the numeric id exists to prevent.
    const env = validEnv() as Record<string, string>;
    env.OWNER_GITHUB_USER_ID = "octocat";
    try {
      loadConfig(env as never);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ConfigError).missing).toContain("OWNER_GITHUB_USER_ID");
      expect((e as ConfigError).message).toMatch(/numeric/i);
    }
  });

  it("REFUSES an OWNER_TIMEZONE that is not a real IANA zone", () => {
    // An invalid zone throws a RangeError inside Intl. Unvalidated, that
    // surfaces as a crash in list_due rather than as a refused deploy.
    const env = validEnv() as Record<string, string>;
    env.OWNER_TIMEZONE = "America/Los_Angles";
    expect(() => loadConfig(env as never)).toThrow(ConfigError);
  });

  it("accepts UTC, which is a real zone and a plausible choice", () => {
    const env = validEnv() as Record<string, string>;
    env.OWNER_TIMEZONE = "UTC";
    expect(loadConfig(env as never).ownerTimezone).toBe("UTC");
  });

  it("REFUSES a COOKIE_ENCRYPTION_KEY that is too short to be 32 bytes", () => {
    const env = validEnv() as Record<string, string>;
    env.COOKIE_ENCRYPTION_KEY = "abcd";
    expect(() => loadConfig(env as never)).toThrow(ConfigError);
  });

  it("never puts a secret in the error message", () => {
    // The error is rendered into a 503 body. A validator that echoes what it
    // rejected is a validator that leaks the thing it was checking.
    const env = validEnv() as Record<string, string>;
    env.COOKIE_ENCRYPTION_KEY = "not-long-enough-but-still-a-secret";
    try {
      loadConfig(env as never);
    } catch (e) {
      expect((e as ConfigError).message).not.toContain("not-long-enough");
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL, cannot resolve `../src/config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS. The five one-at-a-time absence cases plus their empty-string twins are the fail-closed guarantee; the numeric-id case is the one that stops a fail-open being introduced later as a "fix."

- [ ] **Step 5: Extend `env.d.ts`**

Plan 1 declared `DB` and the test-only bindings. Append the plan 2 surface.

```ts
declare global {
  interface Env {
    // From plan 1
    DB: D1Database;

    // Plan 2 bindings
    OAUTH_KV: KVNamespace;
    /** Present only if Task 0 found the binding available on the free plan. */
    RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };

    // Plan 2 variables
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    COOKIE_ENCRYPTION_KEY: string;
    OWNER_GITHUB_USER_ID: string;
    OWNER_TIMEZONE: string;
  }
}

export {};
```

- [ ] **Step 6: Extend `wrangler.jsonc`**

Plan 1's file declared the Worker name, the D1 binding, the migrations directory, and observability. Add the KV namespace and the plain variables. **The secrets are not here** and must never be: `wrangler.jsonc` is committed.

```jsonc
{
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "PLACEHOLDER_SET_BY_DEPLOY" }
  ],
  "vars": {
    "GITHUB_CLIENT_ID": "PLACEHOLDER_SET_BY_DEPLOY",
    "OWNER_GITHUB_USER_ID": "PLACEHOLDER_SET_BY_DEPLOY",
    "OWNER_TIMEZONE": "UTC"
  },
  "observability": { "enabled": true }
}
```

`OWNER_TIMEZONE` defaults to `UTC` rather than to a placeholder, because it is the one variable with a defensible default: UTC is a real zone, so the Worker starts, and the consequence of leaving it is a due-date offset rather than a refusal to run. The other two are placeholders that **fail validation on purpose** - an instance deployed without them should not serve.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts tests/config.test.ts env.d.ts wrangler.jsonc
git commit -m "feat: validate configuration and fail closed when it is incomplete"
```

---

### Task 2: Structured logging that cannot leak PRM content

**Files:**
- Create: `src/log.ts`
- Test: `tests/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function newRequestId(): string`
  - `function logToolCall(fields: { requestId: string; tool: string; durationMs: number; outcome: "ok" | "error"; code?: string }): void`
  - `function logAuthFailure(fields: { requestId: string; presentedUserId: string | null; reason: string }): void`
  - `function logRequest(fields: { requestId: string; method: string; path: string; status: number; durationMs: number }): void`

**This is its own task, before anything that logs, for the same reason plan 1 gave idempotency its own task: it is cross-cutting, and a rule enforced in twelve places is a rule with twelve chances to be broken.** The spec's constraint is absolute - logs carry tool name, duration, outcome, and a request id, and never a name, note, organization, contact detail, or token. Observability is enabled on the deployed Worker, so these logs are readable from the dashboard, and the whole reason that is safe is this module.

**There is exactly one exception, and it is deliberate: authentication failures are logged with the presented numeric id.** A rejected identity is the only signal that someone is probing the instance, and a numeric GitHub user id is public information about a public account. The exception is narrow and named so that nobody widens it.

**The logging functions take structured fields, never a message string.** A `log(message: string)` signature is an invitation to interpolate, and the first interpolation someone reaches for is the person's name they were just writing. There is no function in this module that accepts free text, which makes the rule enforceable by reading one file rather than by reviewing every call site.

- [ ] **Step 1: Write the failing test `tests/log.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logAuthFailure, logRequest, logToolCall, newRequestId } from "../src/log";

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newRequestId", () => {
  it("is unique per call", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe("logToolCall", () => {
  it("emits parseable JSON carrying the fields an operator needs", () => {
    logToolCall({ requestId: "r1", tool: "log_encounter", durationMs: 12, outcome: "ok" });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      request_id: "r1",
      tool: "log_encounter",
      duration_ms: 12,
      outcome: "ok",
    });
  });

  it("carries the error code on a failure, because that is the debuggable part", () => {
    logToolCall({
      requestId: "r1",
      tool: "promote_roster_entry",
      durationMs: 3,
      outcome: "error",
      code: "conflict",
    });
    expect(JSON.parse(lines[0]!).code).toBe("conflict");
  });

  it("HAS NO FIELD that could carry PRM content", () => {
    // The signature is the enforcement. There is no `message`, no `detail`,
    // no `input`, and no `result` - so there is nothing to interpolate a name
    // into, and this rule is checkable by reading one file.
    logToolCall({ requestId: "r1", tool: "get_person", durationMs: 1, outcome: "ok" });
    const entry = JSON.parse(lines[0]!);
    expect(Object.keys(entry).sort()).toEqual([
      "code",
      "duration_ms",
      "event",
      "outcome",
      "request_id",
      "tool",
    ]);
  });
});

describe("logAuthFailure", () => {
  it("records the presented numeric id, which is the one identity exception", () => {
    // A rejected identity is the only signal that someone is probing the
    // instance, and a numeric GitHub id is public information.
    logAuthFailure({ requestId: "r1", presentedUserId: "999999", reason: "not_owner" });
    const entry = JSON.parse(lines[0]!);
    expect(entry.presented_user_id).toBe("999999");
    expect(entry.reason).toBe("not_owner");
  });

  it("handles a request that presented no identity at all", () => {
    logAuthFailure({ requestId: "r1", presentedUserId: null, reason: "no_token" });
    expect(JSON.parse(lines[0]!).presented_user_id).toBeNull();
  });

  it("takes a reason from a fixed set, not free text", () => {
    // Typed as a union in the signature. This test documents the intent; the
    // compiler is what enforces it.
    logAuthFailure({ requestId: "r1", presentedUserId: null, reason: "no_token" });
    expect(JSON.parse(lines[0]!).reason).toBe("no_token");
  });
});

describe("logRequest", () => {
  it("records the path but never a query string", async () => {
    // An OAuth authorize URL carries state and a redirect_uri in its query.
    // Neither is PRM content, but neither belongs in a log an operator will
    // paste into a support thread either.
    logRequest({
      requestId: "r1",
      method: "GET",
      path: "/authorize",
      status: 302,
      durationMs: 4,
    });
    const entry = JSON.parse(lines[0]!);
    expect(entry.path).toBe("/authorize");
    expect(JSON.stringify(entry)).not.toContain("?");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/log.test.ts`
Expected: FAIL, cannot resolve `../src/log`.

- [ ] **Step 3: Write `src/log.ts`**

```ts
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
  /** The pathname ONLY. Never the full URL: an authorize URL's query string
   *  carries state and a redirect_uri, and a log an operator might paste into
   *  a support thread should not carry either. */
  path: string;
  status: number;
  durationMs: number;
}): void {
  emit({
    event: "request",
    request_id: fields.requestId,
    method: fields.method,
    path: fields.path,
    status: fields.status,
    duration_ms: fields.durationMs,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/log.test.ts`
Expected: PASS. The case worth reading is "HAS NO FIELD that could carry PRM content" - it asserts the exact key set, so adding a field to the log entry fails a test rather than quietly widening what gets written to a dashboard.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts tests/log.test.ts
git commit -m "feat: add structured logging that cannot carry PRM content"
```

---

### Task 3: `/health` and the applied schema version

**Files:**
- Create: `src/health.ts`
- Modify: `src/index.ts` - replace plan 1's stub with a real handler that serves `/health` and 404s everything else. OAuth and MCP arrive in Tasks 5 and 7.
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError`, `configErrorResponse` from Task 1; `logRequest`, `newRequestId` from Task 2.
- Produces:
  - `function health(env: Env, requestId: string): Promise<Response>`
  - the first real `src/index.ts`

**`/health` is unauthenticated, and that shapes everything it is allowed to say.** The spec lists it among the routes reachable by anyone who finds the URL, alongside the OAuth endpoints. So it reports three things and no more: that the Worker is alive, the applied schema version, and whether configuration is complete. It does not report the owner id, the client id, row counts, or anything about the data.

**The schema version is what makes drift detectable rather than mysterious.** The spec's upgrade path is: pull, install, apply migrations with `--remote`, deploy, confirm the schema version through `/health`. Without this route, an operator who has deployed new code against an un-migrated database finds out when a tool call fails on a missing column.

**It reads the migration state from D1's own bookkeeping table.** Wrangler's D1 migrations record applied migrations in `d1_migrations`. Reading it rather than hardcoding a version constant means `/health` reports what the *database* believes, not what the *code* believes, which is exactly the disagreement the route exists to surface.

**Configuration completeness is reported, but this route still answers while configuration is broken.** That is the one place `/health` deliberately diverges from the fail-closed rule: an operator debugging an unconfigured instance needs *something* to answer, and this route holds no data. Tools stay refused.

- [ ] **Step 1: Write the failing test `tests/health.test.ts`**

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
});

describe("GET /health", () => {
  it("reports ok, the applied schema version, and configured state", async () => {
    const response = await SELF.fetch("https://example.test/health");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      schema_version: string | null;
      configured: boolean;
    };
    expect(body.status).toBe("ok");
    // The migrations from plan 1 have been applied by the test harness.
    expect(body.schema_version).toBe("0004_search.sql");
    expect(body.configured).toBe(true);
  });

  it("REVEALS NOTHING about the owner or the data", async () => {
    const response = await SELF.fetch("https://example.test/health");
    const text = await response.text();
    // Unauthenticated route. Anyone who finds the URL can read this.
    expect(text).not.toContain("OWNER");
    expect(text).not.toContain(env.OWNER_GITHUB_USER_ID);
    expect(text).not.toContain(env.GITHUB_CLIENT_ID);
    expect(text.toLowerCase()).not.toContain("secret");
    // No row counts either: "42 people" tells a stranger the instance is in use.
    expect(text).not.toMatch(/\bcount\b/i);
  });

  it("carries a request id so a report can be matched to a log line", async () => {
    const response = await SELF.fetch("https://example.test/health");
    const body = (await response.json()) as { request_id: string };
    expect(body.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("is never cached, because a cached health check is not a health check", async () => {
    const response = await SELF.fetch("https://example.test/health");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("STILL ANSWERS when configuration is incomplete, and says so", async () => {
    // The one place /health diverges from fail-closed: an operator debugging an
    // unconfigured instance needs something to answer, and this route holds no
    // data. Tools stay refused - see Task 7.
    const broken = { ...env, OWNER_GITHUB_USER_ID: "" } as never;
    const { health } = await import("../src/health");
    const response = await health(broken, "r1");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; configured: boolean };
    expect(body.status).toBe("ok");
    expect(body.configured).toBe(false);
  });

  it("reports a null schema version rather than failing when migrations have not run", async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS d1_migrations").run();
    const { health } = await import("../src/health");
    const body = (await (await health(env, "r1")).json()) as { schema_version: string | null };
    expect(body.schema_version).toBeNull();
  });
});

describe("everything else", () => {
  it("404s an unknown path", async () => {
    const response = await SELF.fetch("https://example.test/nope");
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/health.test.ts`
Expected: FAIL. Plan 1's stub returns 501 for every path, so the first case fails on the status.

- [ ] **Step 3: Write `src/health.ts`**

```ts
import { loadConfig } from "./config";

/**
 * UNAUTHENTICATED. Anyone who finds the Worker URL can read this response, so
 * it reports exactly three things: that the Worker is alive, what schema
 * version the DATABASE believes it is on, and whether configuration is
 * complete. No owner id, no client id, no row counts.
 *
 * A row count would be a small leak with no upside: "42 people" tells a
 * stranger the instance is in use and worth a second look.
 */
export async function health(env: Env, requestId: string): Promise<Response> {
  let configured = true;
  try {
    loadConfig(env);
  } catch {
    // Deliberately swallowed. This route answers either way; it just says which.
    // The reason is not reported here - `configErrorResponse` from Task 1 does
    // that on the routes that actually refuse.
    configured = false;
  }

  return json(
    {
      status: "ok",
      schema_version: await appliedSchemaVersion(env),
      configured,
      request_id: requestId,
    },
    200
  );
}

/**
 * What the DATABASE believes, not what the code believes.
 *
 * Wrangler's D1 migrations record each applied file in `d1_migrations`. Reading
 * it means `/health` surfaces the disagreement it exists to catch: new code
 * deployed against a database nobody ran `--remote` migrations on. A hardcoded
 * constant would report the code's opinion and agree with itself forever.
 *
 * Returns null rather than throwing when the table is absent, which is the
 * state of a database that has never been migrated at all - a real situation
 * during a first deploy, and one an operator needs `/health` to survive.
 */
async function appliedSchemaVersion(env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"
    ).first<{ name: string }>();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      // A cached health check is not a health check.
      "cache-control": "no-store",
    },
  });
}
```

- [ ] **Step 4: Replace `src/index.ts`**

Plan 1 left a stub returning 501. This is the first real entrypoint.

**It is replaced twice more, and that is intended rather than churn.** Task 5 rewrites it so the OAuth provider is the handler, and Task 8 wraps that in a rate limiter. Each version is written out in full in its own task rather than as a diff, because an agent executing one task should never have to reconstruct the current state of a file from three partial edits. If you are reading these out of order, **the version in Task 8 is the final one.**

```ts
import { health } from "./health";
import { logRequest, newRequestId } from "./log";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    const url = new URL(request.url);

    const response =
      url.pathname === "/health"
        ? await health(env, requestId)
        : new Response("not found", { status: 404 });

    // `path`, never `url`: an authorize URL's query string carries state and a
    // redirect_uri, and neither belongs in a log line.
    logRequest({
      requestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });

    return response;
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/health.test.ts`
Expected: PASS. The case that matters is "REVEALS NOTHING about the owner or the data" - this route is on the public internet from the moment the Worker deploys, and everything else in this plan is behind OAuth.

- [ ] **Step 6: Commit**

```bash
git add src/health.ts src/index.ts tests/health.test.ts
git commit -m "feat: serve /health with the applied schema version"
```

---

### Task 4: The GitHub OAuth client side

**Files:**
- Create: `src/auth/github.ts`
- Test: `tests/auth-github.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1, `logAuthFailure` from Task 2.
- Produces:
  - `function authorizeUrl(config: Config, callbackUrl: string, state: string): string`
  - `function exchangeCode(config: Config, code: string): Promise<string>` - returns the GitHub access token
  - `function resolveUserId(accessToken: string): Promise<string>` - returns the **numeric** id as a string
  - `function completeCallback(config: Config, code: string): Promise<{ githubUserId: string }>` - the whole flow, token discarded before it returns
  - `class GitHubAuthError extends Error { reason: string }`

**This is the side the project actually writes.** `workers-oauth-provider` implements the Claude-facing half in full, so that side is a configuration job. This half - the authorization redirect, the callback, the token exchange, and the call that resolves the signed-in identity - is a build job, and it is where the security-relevant decisions live.

**All GitHub-specific code lives in this file and nowhere else.** The spec is explicit that there is **no identity-provider abstraction**: an earlier draft specified a seam so a second provider could be added behind it, and with GitHub as the only provider that seam would be an interface with one implementation, written against a second implementation that may never exist. The arrangement is exactly this - one findable module - and if a second provider is ever added, the interface gets extracted then, against two real cases rather than one real case and one imagined one.

Three details, each easy to get wrong by following a template:

**No scopes are requested.** `https://api.github.com/user` returns the numeric id with an unscoped token. Asking for `read:user` by reflex widens both the consent screen shown to the stranger this project is trying not to lose and the blast radius if anything leaks. The `scope` parameter is omitted entirely rather than sent empty.

**The access token is discarded the moment the identity is resolved.** `completeCallback` exists so that no caller ever holds the token: it goes in, a numeric id comes out, and the token is never returned, stored, or logged. Cloudflare's `workers-oauth-provider` examples stash upstream tokens in grant props, so an implementer following the template ends up with the owner's live GitHub credential sitting in KV on an instance whose entire security argument is one environment variable.

**The numeric `id` is what is read, never `login`.** GitHub's `/user` response carries both. `login` is the username, it can be changed and the old one re-registered by someone else, and reading it here would put a takeover vector into the one function that decides who the owner is.

- [ ] **Step 1: Write the failing test `tests/auth-github.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config";
import {
  authorizeUrl,
  completeCallback,
  exchangeCode,
  GitHubAuthError,
  resolveUserId,
} from "../src/auth/github";

const config: Config = {
  githubClientId: "Iv1.abc123",
  githubClientSecret: "shhh",
  cookieKey: "0".repeat(64),
  ownerGithubUserId: "583231",
  ownerTimezone: "UTC",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("authorizeUrl", () => {
  it("points at GitHub with the client id, callback, and state", () => {
    const url = new URL(authorizeUrl(config, "https://prm.example.test/callback", "st4te"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://prm.example.test/callback");
    expect(url.searchParams.get("state")).toBe("st4te");
  });

  it("REQUESTS NO SCOPES AT ALL", () => {
    // Not an empty scope - absent. /user returns the numeric id unscoped, and
    // asking for read:user by reflex widens the consent screen shown to the
    // stranger this project is trying not to lose.
    const url = new URL(authorizeUrl(config, "https://prm.example.test/callback", "st4te"));
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("never puts the client secret in the URL", () => {
    const url = authorizeUrl(config, "https://prm.example.test/callback", "st4te");
    expect(url).not.toContain("shhh");
  });
});

describe("exchangeCode", () => {
  it("posts the code and returns the access token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "gho_token" }));
    const token = await exchangeCode(config, "the-code");
    expect(token).toBe("gho_token");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://github.com/login/oauth/access_token");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("asks for JSON, because GitHub returns form-encoding by default", async () => {
    // Without an Accept header GitHub answers
    // `access_token=gho_x&scope=&token_type=bearer`, and response.json() throws.
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "gho_token" }));
    await exchangeCode(config, "the-code");
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("treats GitHub's 200-with-an-error-body as a failure", async () => {
    // GitHub answers a bad code with HTTP 200 and {"error":"bad_verification_code"}.
    // Checking response.ok alone accepts it and returns undefined as the token.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "bad_verification_code", error_description: "expired" })
    );
    await expect(exchangeCode(config, "stale")).rejects.toThrow(GitHubAuthError);
  });

  it("fails rather than returning undefined when the body has no token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(exchangeCode(config, "the-code")).rejects.toThrow(GitHubAuthError);
  });

  it("fails on a non-200", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(exchangeCode(config, "the-code")).rejects.toThrow(GitHubAuthError);
  });
});

describe("resolveUserId", () => {
  it("returns the NUMERIC id as a string, never the login", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 583231, login: "octocat" }));
    expect(await resolveUserId("gho_token")).toBe("583231");
  });

  it("sends a User-Agent, which the GitHub API requires", async () => {
    // GitHub rejects API requests with no User-Agent with a 403, and the error
    // body does not obviously say so.
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, login: "x" }));
    await resolveUserId("gho_token");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers((init as RequestInit).headers).get("user-agent")).toBeTruthy();
  });

  it("fails when the response carries no numeric id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
    await expect(resolveUserId("gho_token")).rejects.toThrow(GitHubAuthError);
  });

  it("fails on a revoked token", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));
    await expect(resolveUserId("gone")).rejects.toThrow(GitHubAuthError);
  });
});

describe("completeCallback", () => {
  it("returns only the numeric id, and NEVER the access token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_secret_token" }))
      .mockResolvedValueOnce(jsonResponse({ id: 583231, login: "octocat" }));

    const result = await completeCallback(config, "the-code");
    expect(result).toEqual({ githubUserId: "583231" });
    // The token has no further purpose. The provider examples stash it in grant
    // props, which would leave a live GitHub credential in KV.
    expect(JSON.stringify(result)).not.toContain("gho_secret_token");
    expect(Object.keys(result)).toEqual(["githubUserId"]);
  });

  it("does not resolve an identity when the exchange failed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad_verification_code" }));
    await expect(completeCallback(config, "stale")).rejects.toThrow(GitHubAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/auth-github.test.ts`
Expected: FAIL, cannot resolve `../src/auth/github`.

- [ ] **Step 3: Write `src/auth/github.ts`**

```ts
import type { Config } from "../config";

/**
 * ALL GitHub-specific code lives in this file.
 *
 * There is deliberately no identity-provider interface. The spec considered one
 * and rejected it: with GitHub as the only provider, a seam would be an
 * interface with one implementation, written against a second implementation
 * that may never exist. If a second provider is ever added, the interface gets
 * extracted then, against two real cases rather than one real and one imagined.
 */

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN = "https://github.com/login/oauth/access_token";
const USER = "https://api.github.com/user";

/** GitHub's API rejects requests with no User-Agent with a 403 that does not say so. */
const USER_AGENT = "junco-prm";

export class GitHubAuthError extends Error {
  constructor(
    message: string,
    public readonly reason: string
  ) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/**
 * NO SCOPE PARAMETER. Not an empty one - absent.
 *
 * /user returns the numeric id with an unscoped token, so asking for read:user
 * buys nothing and costs a wider consent screen shown to exactly the stranger
 * this project is trying not to lose.
 */
export function authorizeUrl(config: Config, callbackUrl: string, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(config: Config, code: string): Promise<string> {
  const response = await fetch(ACCESS_TOKEN, {
    method: "POST",
    headers: {
      // Without this, GitHub answers form-encoded and .json() throws.
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new GitHubAuthError(`token exchange returned ${response.status}`, "exchange_http");
  }

  // GitHub answers a bad or expired code with HTTP 200 and an error body.
  // Checking response.ok alone accepts it and hands back undefined as a token.
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (body.error) {
    throw new GitHubAuthError(`token exchange refused: ${body.error}`, "exchange_refused");
  }
  if (!body.access_token) {
    throw new GitHubAuthError("token exchange returned no access_token", "exchange_empty");
  }
  return body.access_token;
}

/**
 * The NUMERIC id, as a string. Never `login`.
 *
 * GitHub's /user response carries both. A username can be changed and the old
 * one re-registered by someone else, so reading it here would put an account
 * takeover into the one function that decides who the owner is.
 */
export async function resolveUserId(accessToken: string): Promise<string> {
  const response = await fetch(USER, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new GitHubAuthError(`/user returned ${response.status}`, "identity_http");
  }

  const body = (await response.json()) as { id?: number; login?: string };
  if (typeof body.id !== "number") {
    throw new GitHubAuthError("/user returned no numeric id", "identity_empty");
  }
  return String(body.id);
}

/**
 * THE WHOLE FLOW, and the reason it is one function rather than two calls at
 * the call site: the access token never escapes this scope.
 *
 * It goes in, a numeric id comes out, and the token is never returned, stored,
 * or logged. Cloudflare's workers-oauth-provider examples stash upstream tokens
 * in grant props, so an implementer following the template ends up with the
 * owner's live GitHub credential sitting in KV - on an instance whose entire
 * security argument is one environment variable.
 */
export async function completeCallback(
  config: Config,
  code: string
): Promise<{ githubUserId: string }> {
  const accessToken = await exchangeCode(config, code);
  const githubUserId = await resolveUserId(accessToken);
  // `accessToken` goes out of scope here and is never persisted anywhere.
  return { githubUserId };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/auth-github.test.ts`
Expected: PASS.

Three cases carry the weight. "REQUESTS NO SCOPES AT ALL" and "returns only the numeric id, and NEVER the access token" are the two places a template-following implementer diverges from this spec, and both diverge silently - a wider consent screen and a stored credential neither break anything nor announce themselves. "treats GitHub's 200-with-an-error-body as a failure" is the one that bites during development: an expired code produces HTTP 200, and the naive check hands `undefined` to `resolveUserId`, which then fails with a 401 that sends the implementer looking in entirely the wrong place.

- [ ] **Step 5: Commit**

```bash
git add src/auth/github.ts tests/auth-github.test.ts
git commit -m "feat: resolve the owner's numeric GitHub id and discard the token"
```

---

### Task 5: `workers-oauth-provider` and the Claude-facing server

**Files:**
- Create: `src/auth/provider.ts`
- Modify: `src/index.ts` - the provider becomes the fetch handler
- Test: `tests/auth-provider.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1, `authorizeUrl` and `completeCallback` from Task 4, `logAuthFailure` from Task 2.
- Produces:
  - `interface GrantProps { githubUserId: string }` - **the only thing ever written into a grant**
  - `function buildProvider(config: Config, apiHandler: ExportedHandler): { fetch(request, env, ctx): Promise<Response> }`
  - `const ALLOWED_REDIRECT_HOSTS: readonly string[]`
  - `const CLIENT_REGISTRATION_TTL_SECONDS: number`

**This is the Worker being an OAuth server to Claude, and it is a configuration job rather than a build job.** `workers-oauth-provider` implements Dynamic Client Registration, PKCE, metadata discovery, and bearer token issuance and validation in full. What it does **not** do is the application's work, and the spec says so plainly: consent, CSRF protection, state validation, cookie handling, and every application-level access check remain this project's responsibility. The library validates its own issued token and explicitly leaves authorization to the handler - which is Task 6.

**`GrantProps` has exactly one field, and that is a security decision, not a minimalism preference.** Whatever goes into props is persisted in KV for the life of the grant. The numeric GitHub user id is all that is needed to authorize a request, so it is all that is stored. No access token, no username, no email, no avatar URL. The type is declared with one field so that adding a second is a visible edit to a named interface rather than an extra key in an object literal.

**Two decisions this task has to make that the spec left open.**

The spec says registered clients "expire on a default lifetime, which a long-lived personal instance has to choose deliberately rather than inherit," and it says accepted redirect URIs should be constrained to Anthropic's documented callback. Neither has a value in the spec. This task sets both:

- **`ALLOWED_REDIRECT_HOSTS`** is `claude.ai` and `claude.com`. Anthropic's documented callback is `https://claude.ai/api/mcp/auth_callback`, and matching on host rather than on the exact URL leaves room for the path to change without a redeploy, while still refusing a registration that points somewhere else entirely. Desktop and local clients use loopback, so `127.0.0.1` and `localhost` are accepted **only over http on a loopback host**, which is the standard OAuth native-app exception.
- **`CLIENT_REGISTRATION_TTL_SECONDS`** is **one year**, and the reasoning matters more than the number because the obvious reasoning is wrong.

  The tempting argument is that Dynamic Client Registration is an unauthenticated write, so registrations should not accumulate forever, so the TTL should be short. A first draft of this plan used 90 days on exactly that basis. It does not hold up.

  **A short TTL defends against the wrong half of the threat.** A registration loop's real cost on a free plan is KV *writes*, which are capped daily. A TTL reclaims *storage*, and does nothing whatever about the writes - those already happened by the time any expiry is relevant. The rate limiter in Task 8 is what bounds the writes. So the thing a short TTL was chosen to defend is defended somewhere else, and what a short TTL actually buys is reclaimed storage, which is the cheap part.

  **Meanwhile the cost of expiring too early lands on the owner.** Whether that cost is small or large depends on something this plan does not know: what a client actually experiences when its registration lapses. If Claude silently re-registers, expiry is invisible. If instead the connector simply stops working, the owner gets a PRM that broke for no visible reason and no message explaining it - which is a genuinely bad failure on a tool someone reaches for while standing in front of another person.

  The asymmetry therefore runs the other way from the first draft's assumption: the downside of expiring early is real and lands on the owner, the upside of expiring at all is small and already covered. A year is long enough that the question almost never arises, while still not being "never" - an instance that has been abandoned for a year has no business holding live client registrations.

  **One thing to check while implementing this task, because it would settle the question properly:** read `workers-oauth-provider`'s docs or types for what a client sees when its registration lapses. If it re-registers transparently, a shorter TTL becomes defensible and this constant can come down. If it does not, a year is right and the reasoning above is the reason. Either way, record what you found in a comment - the next reader should not have to re-derive this.

**Neither of these closes the DCR hole, and the spec is explicit that they do not.** A registration still costs a KV write, and the rate limiter in Task 8 is per-location and permissive. Constraining redirect URIs bounds the *usefulness* of a junk registration; the TTL bounds its *lifetime*; the limiter bounds the *rate*. The hole is narrowed on three sides and not closed, which is the honest description.

- [ ] **Step 1: Write the failing test `tests/auth-provider.test.ts`**

```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ALLOWED_REDIRECT_HOSTS, isAllowedRedirect } from "../src/auth/provider";

describe("redirect URI constraints", () => {
  it("accepts Anthropic's documented callback", () => {
    expect(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
  });

  it("accepts claude.com as well as claude.ai", () => {
    expect(isAllowedRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
  });

  it("accepts a loopback callback over http, the native-app exception", () => {
    expect(isAllowedRedirect("http://127.0.0.1:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirect("http://localhost:6274/oauth/callback")).toBe(true);
  });

  it("REFUSES an arbitrary host", () => {
    expect(isAllowedRedirect("https://evil.test/steal")).toBe(false);
  });

  it("REFUSES a lookalike host", () => {
    // The registration is unauthenticated, so this is the check that stops a
    // registered client from redirecting an authorization code off-site.
    expect(isAllowedRedirect("https://claude.ai.evil.test/cb")).toBe(false);
    expect(isAllowedRedirect("https://notclaude.ai/cb")).toBe(false);
  });

  it("REFUSES http to a non-loopback host", () => {
    expect(isAllowedRedirect("http://claude.ai/api/mcp/auth_callback")).toBe(false);
  });

  it("REFUSES a non-http scheme", () => {
    expect(isAllowedRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirect("data:text/html,x")).toBe(false);
  });

  it("REFUSES an unparseable value rather than throwing", () => {
    expect(isAllowedRedirect("not a url")).toBe(false);
    expect(isAllowedRedirect("")).toBe(false);
  });

  it("lists the hosts it allows, so the set is reviewable", () => {
    expect([...ALLOWED_REDIRECT_HOSTS]).toEqual(["claude.ai", "claude.com"]);
  });
});

describe("the provider's own routes", () => {
  it("serves OAuth metadata discovery", async () => {
    const response = await SELF.fetch(
      "https://example.test/.well-known/oauth-authorization-server"
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.authorization_endpoint).toContain("/authorize");
    expect(body.token_endpoint).toContain("/token");
    expect(body.registration_endpoint).toContain("/register");
  });

  it("still serves /health, which the provider must not swallow", async () => {
    // The provider is the fetch handler now. If /health is not routed around
    // it, an operator loses the one diagnostic that works before OAuth does.
    const response = await SELF.fetch("https://example.test/health");
    expect(response.status).toBe(200);
  });

  it("REFUSES to serve anything when configuration is incomplete", async () => {
    // Fail closed. This is the whole security floor from Task 1, asserted at
    // the layer that actually serves requests.
    const { default: worker } = await import("../src/index");
    const broken = { ...env, GITHUB_CLIENT_SECRET: "" } as never;
    const response = await worker.fetch(
      new Request("https://example.test/authorize?client_id=x"),
      broken,
      {} as ExecutionContext
    );
    expect(response.status).toBe(503);
  });
});

describe("grant props", () => {
  it("carries the numeric id and NOTHING else", async () => {
    // Whatever goes in props is persisted in KV for the life of the grant.
    // This test is the guard on that surface: it fails if a second field is
    // ever added, including an access token.
    const { propsFor } = await import("../src/auth/provider");
    expect(propsFor("583231")).toEqual({ githubUserId: "583231" });
    expect(Object.keys(propsFor("583231"))).toEqual(["githubUserId"]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/auth-provider.test.ts`
Expected: FAIL, cannot resolve `../src/auth/provider`.

- [ ] **Step 3: Write `src/auth/provider.ts`**

```ts
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Config } from "../config";
import { logAuthFailure } from "../log";
import { authorizeUrl, completeCallback, GitHubAuthError } from "./github";

/**
 * THE ONLY THING EVER WRITTEN INTO A GRANT.
 *
 * Props are persisted in KV for the life of the grant. The numeric GitHub user
 * id is all that is needed to authorize a request, so it is all that is stored:
 * no access token, no username, no email.
 *
 * This is declared as a named interface with one field so that adding a second
 * is a visible edit to a type rather than an extra key in an object literal
 * somewhere in a callback.
 */
export interface GrantProps {
  githubUserId: string;
}

export function propsFor(githubUserId: string): GrantProps {
  return { githubUserId };
}

/**
 * Anthropic's documented callback is https://claude.ai/api/mcp/auth_callback.
 * Matching on HOST rather than the exact URL leaves room for the path to change
 * without a redeploy, while still refusing a registration pointing elsewhere.
 */
export const ALLOWED_REDIRECT_HOSTS = ["claude.ai", "claude.com"] as const;

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Dynamic Client Registration is an UNAUTHENTICATED WRITE - anyone who finds
 * the URL can register clients. This check does not close that hole; it bounds
 * how useful a junk registration is, by refusing one that would redirect an
 * authorization code somewhere the project does not recognize.
 */
export function isAllowedRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // The native-app loopback exception: http is acceptable to a loopback host
  // and nowhere else. Desktop and local inspector clients need this.
  if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return true;
  if (url.protocol !== "https:") return false;

  // Exact host equality, never endsWith: `claude.ai.evil.test` ends with
  // nothing useful but `notclaude.ai` would pass a naive suffix check.
  return (ALLOWED_REDIRECT_HOSTS as readonly string[]).includes(url.hostname);
}

/**
 * ONE YEAR.
 *
 * The spec says registered clients expire on a default lifetime "which a
 * long-lived personal instance has to choose deliberately rather than inherit,"
 * and gives no number. This is the choice, and it is deliberately long.
 *
 * The obvious reasoning points the other way and is wrong. It goes: DCR is an
 * unauthenticated write, so registrations should not accumulate, so keep the
 * TTL short. But a short TTL defends the wrong half of that threat. A
 * registration loop's real cost on a free plan is KV WRITES, which are capped
 * daily and have already happened by the time any expiry matters; a TTL only
 * reclaims STORAGE, which is the cheap part. The rate limiter in Task 8 is what
 * actually bounds the writes.
 *
 * Against that small upside, expiring early costs the OWNER. What it costs
 * depends on something this plan does not know - whether a client re-registers
 * transparently when its registration lapses, or simply stops working. If the
 * latter, a short TTL means a PRM that breaks for no visible reason, on a tool
 * someone reaches for while standing in front of another person.
 *
 * So: long, but not infinite. An instance abandoned for a year has no business
 * holding live client registrations.
 *
 * TO SETTLE THIS PROPERLY: check what workers-oauth-provider does to a client
 * whose registration has lapsed. If it re-registers transparently, this can
 * come down. Record what you find here rather than leaving the next reader to
 * re-derive it.
 */
export const CLIENT_REGISTRATION_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * The Worker as an OAuth SERVER to Claude.
 *
 * The library supplies protocol machinery, not an application. Consent, CSRF
 * protection, state validation, cookie handling, and every application-level
 * access check remain this project's responsibility - the library validates its
 * own issued bearer token and explicitly leaves authorization to the handler.
 * That handler is Task 6.
 */
export function buildProvider(config: Config, apiHandler: ExportedHandler) {
  return new OAuthProvider({
    // The MCP endpoint. Everything under it requires a valid bearer token.
    apiRoute: "/mcp",
    apiHandler,

    // The provider serves these itself. A rate limiter must therefore wrap the
    // provider, not sit behind it - see Task 8.
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",

    defaultHandler: githubHandler(config),

    // Encrypts the consent cookie. Validated at startup by Task 1.
    cookieSecret: config.cookieKey,

    allowedRedirectUriHosts: [...ALLOWED_REDIRECT_HOSTS],
    clientRegistrationTtlSeconds: CLIENT_REGISTRATION_TTL_SECONDS,
  });
}

/**
 * The bridge between the two OAuth roles.
 *
 * The provider hands off here to get the user authenticated. This handler runs
 * the GitHub side (Task 4), gets a numeric id back, and completes the
 * provider's authorization with that id in props. It is the ONLY place the two
 * halves touch, and the only thing that crosses between them is the id.
 */
function githubHandler(config: Config): ExportedHandler {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          return new Response("missing code or state", { status: 400 });
        }

        try {
          const { githubUserId } = await completeCallback(config, code);

          // The access token is already gone - completeCallback never returned
          // it. Only the numeric id reaches props.
          const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
            request: decodeAuthRequest(state),
            userId: githubUserId,
            metadata: {},
            scope: [],
            props: propsFor(githubUserId),
          });
          return Response.redirect(redirectTo, 302);
        } catch (e) {
          const reason = e instanceof GitHubAuthError ? e.reason : "callback_failed";
          logAuthFailure({ requestId: url.searchParams.get("rid") ?? "-", presentedUserId: null, reason: "invalid_token" });
          return new Response(`sign-in failed: ${reason}`, { status: 401 });
        }
      }

      // The provider routes /authorize here when it needs the user signed in.
      const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const callbackUrl = new URL("/callback", url.origin).toString();
      return Response.redirect(
        authorizeUrl(config, callbackUrl, encodeAuthRequest(authRequest)),
        302
      );
    },
  } satisfies ExportedHandler;
}

/**
 * The provider's auth request is round-tripped through GitHub's `state`
 * parameter, which is what ties the callback back to the authorization it
 * belongs to. It is base64url over JSON - opaque to GitHub, and validated by
 * the provider when it is presented back.
 */
function encodeAuthRequest(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeAuthRequest(state: string): never {
  const base64 = state.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as never;
}
```

**A note for whoever implements this.** `workers-oauth-provider`'s exact option names and the shape of `parseAuthRequest` / `completeAuthorization` are the one place in this plan where the code above is written against a library API rather than against a platform primitive, and it is the thing most likely to have moved. **Read the installed package's types before writing this file**, and if a name differs, follow the package rather than this document - the *structure* here is what matters: the provider serves its three endpoints, a default handler bridges to GitHub, and only the numeric id crosses into props. Record any correction in a comment so the next reader knows the document is behind rather than wrong.

- [ ] **Step 4: Rewrite `src/index.ts` so the provider is the handler**

```ts
import { buildProvider } from "./auth/provider";
import { ConfigError, configErrorResponse, loadConfig } from "./config";
import { health } from "./health";
import { logRequest, newRequestId } from "./log";
import { mcpHandler } from "./mcp/transport"; // arrives in Task 7

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    const url = new URL(request.url);

    const finish = (response: Response) => {
      logRequest({
        requestId,
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    };

    // /health answers before configuration is checked, and it is the ONLY route
    // that does. An operator debugging an unconfigured instance needs something
    // to answer, and this route holds no data.
    if (url.pathname === "/health") return finish(await health(env, requestId));

    // FAIL CLOSED. Everything below this line - OAuth and tools alike - is
    // unreachable until every secret and variable is present and valid.
    let config;
    try {
      config = loadConfig(env);
    } catch (e) {
      if (e instanceof ConfigError) return finish(configErrorResponse(e, requestId));
      throw e;
    }

    const provider = buildProvider(config, mcpHandler(config, requestId));
    return finish(await provider.fetch(request, env, ctx));
  },
};
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/auth-provider.test.ts tests/health.test.ts`
Expected: PASS. The `/health` case in both files is deliberately duplicated: Task 3 proved the route works, and this task proves the provider did not swallow it when it became the fetch handler.

- [ ] **Step 6: Commit**

```bash
git add src/auth/provider.ts src/index.ts tests/auth-provider.test.ts
git commit -m "feat: serve OAuth to Claude and bridge sign-in to GitHub"
```

---

### Task 6: Per-request owner authorization

**Files:**
- Create: `src/auth/authorize.ts`
- Test: `tests/authorize.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1, `GrantProps` from Task 5, `logAuthFailure` from Task 2.
- Produces:
  - `function assertOwner(config: Config, props: unknown, requestId: string): string` - returns the numeric id, throws `NotOwnerError` otherwise
  - `class NotOwnerError extends Error { reason: "no_props" | "not_owner" }`

**This is the single function standing between a stranger and the database, and it is its own module for that reason.** It is nine lines of logic guarding every byte of data in the system. A nine-line function in its own file with its own test file is reviewable in one sitting; the same nine lines inside a 200-line transport module are not.

**Three properties, each of which the spec calls out and each of which is easy to lose.**

**It runs on every request, not only at sign-in.** The spec: revoking access has to mean the *next request* fails, not the next login. `workers-oauth-provider` validates its own issued bearer token and explicitly leaves authorization to the handler, so a handler that trusts a valid token has skipped this entirely - and a valid token belonging to the wrong GitHub account is exactly the case the spec names as non-negotiable to test.

**It compares against the CURRENT environment variable, not against anything stored.** This is what makes revocation-by-allowlist-change immediate. The alternative - deleting the grant from KV - is subject to KV's eventual consistency, and the spec notes a deletion can take a minute or more to propagate. Changing `OWNER_GITHUB_USER_ID` and redeploying invalidates every existing grant on the very next request, because every existing grant carries the *old* id in its props and the comparison now fails.

**It never calls GitHub.** The numeric id was written into props at consent time; the check reads it from there. Calling `/user` per request would spend a 5,000-per-hour quota on routine tool calls and add a network round trip to every one.

**A missing or malformed props object is a refusal, never a pass.** This is the fail-open that a defensive-coding reflex introduces: `props?.githubUserId === config.ownerGithubUserId` is correct, but `if (props?.githubUserId && props.githubUserId !== owner) throw` is not - it lets a grant with no props through. The test file covers `null`, `undefined`, `{}`, a string, and an array, because each of those is a shape a hand-edited or partially-migrated KV entry could actually take.

- [ ] **Step 1: Write the failing test `tests/authorize.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertOwner, NotOwnerError } from "../src/auth/authorize";
import type { Config } from "../src/config";

const config: Config = {
  githubClientId: "Iv1.abc",
  githubClientSecret: "shhh",
  cookieKey: "0".repeat(64),
  ownerGithubUserId: "583231",
  ownerTimezone: "UTC",
};

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertOwner", () => {
  it("accepts the owner", () => {
    expect(assertOwner(config, { githubUserId: "583231" }, "r1")).toBe("583231");
  });

  it("REFUSES a valid grant belonging to a different GitHub account", () => {
    // The spec calls this test non-negotiable. The token is genuine and the
    // provider validated it; the person behind it is not the owner.
    expect(() => assertOwner(config, { githubUserId: "999999" }, "r1")).toThrow(NotOwnerError);
  });

  it("REFUSES every shape of missing props", () => {
    // The fail-open a defensive reflex introduces is
    // `if (props?.githubUserId && props.githubUserId !== owner) throw`,
    // which lets a grant with NO props straight through.
    for (const props of [null, undefined, {}, { githubUserId: null }, "583231", ["583231"], 583231]) {
      expect(() => assertOwner(config, props, "r1"), String(props)).toThrow(NotOwnerError);
    }
  });

  it("REFUSES a numeric id that only differs by type", () => {
    // Props round-trip through JSON in KV. A number that was stored as a number
    // must not pass a comparison written for strings, and must not silently
    // coerce either - it means the write path changed and should be noticed.
    expect(() => assertOwner(config, { githubUserId: 583231 }, "r1")).toThrow(NotOwnerError);
  });

  it("REFUSES a padded or whitespaced id rather than trimming it", () => {
    expect(() => assertOwner(config, { githubUserId: " 583231" }, "r1")).toThrow(NotOwnerError);
    expect(() => assertOwner(config, { githubUserId: "0583231" }, "r1")).toThrow(NotOwnerError);
  });

  it("compares against the CURRENT config, which is what makes revocation immediate", () => {
    const grant = { githubUserId: "583231" };
    expect(assertOwner(config, grant, "r1")).toBe("583231");

    // The operator changed OWNER_GITHUB_USER_ID and redeployed. Every existing
    // grant still carries the old id, so the very next request fails - without
    // waiting on KV's eventual consistency to propagate a deletion.
    const rotated = { ...config, ownerGithubUserId: "111111" };
    expect(() => assertOwner(rotated, grant, "r1")).toThrow(NotOwnerError);
  });

  it("LOGS the presented id on refusal, which is the one identity exception", () => {
    // A rejected identity is the only signal that someone is probing.
    try {
      assertOwner(config, { githubUserId: "999999" }, "r1");
    } catch {
      /* expected */
    }
    const entry = JSON.parse(lines[0]!);
    expect(entry.event).toBe("auth_failure");
    expect(entry.presented_user_id).toBe("999999");
    expect(entry.reason).toBe("not_owner");
  });

  it("logs a null presented id when there were no props to read", () => {
    try {
      assertOwner(config, {}, "r1");
    } catch {
      /* expected */
    }
    const entry = JSON.parse(lines[0]!);
    expect(entry.presented_user_id).toBeNull();
    expect(entry.reason).toBe("no_props");
  });

  it("logs NOTHING on success, because a successful request is not a security event", () => {
    assertOwner(config, { githubUserId: "583231" }, "r1");
    expect(lines).toEqual([]);
  });

  it("never calls GitHub", () => {
    // Per-request identity resolution would spend a 5,000-per-hour quota on
    // routine tool calls and add a round trip to every one.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    assertOwner(config, { githubUserId: "583231" }, "r1");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/authorize.test.ts`
Expected: FAIL, cannot resolve `../src/auth/authorize`.

- [ ] **Step 3: Write `src/auth/authorize.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/authorize.test.ts`
Expected: PASS.

Two cases are the reason this module exists. "REFUSES every shape of missing props" runs seven shapes through the check because each is something a hand-edited or partially-migrated KV entry could actually be, and a single `null` case would not catch the reflexive fail-open. "compares against the CURRENT config" is the one that proves the revocation story the spec tells - without it, revocation depends on a KV delete propagating, which the spec explicitly says is too slow to rely on.

- [ ] **Step 5: Commit**

```bash
git add src/auth/authorize.ts tests/authorize.test.ts
git commit -m "feat: check the owner's numeric id on every request"
```

---

### Task 7: MCP over stateless Streamable HTTP

**Files:**
- Create: `src/mcp/errors.ts`, `src/mcp/server.ts`, `src/mcp/transport.ts`
- Test: `tests/mcp.test.ts`
- Modify: `package.json` - add `@modelcontextprotocol/sdk`

**Interfaces:**
- Consumes: `TOOLS` from plan 1's `src/tools/index.ts`, `ToolError` from plan 1's `src/errors.ts`, `assertOwner` from Task 6, `Config` from Task 1, `logToolCall` from Task 2.
- Produces:
  - `function toolErrorResult(e: ToolError): CallToolResult` - the seven codes crossing the transport boundary
  - `function buildServer(config: Config, env: Env, requestId: string): McpServer`
  - `function mcpHandler(config: Config, requestId: string): ExportedHandler`

**This is the task that makes everything before it usable.** Plan 1 built 28 tools nobody could reach; Tasks 1 through 6 built a Worker that authenticates but serves nothing. This connects them, and it is deliberately thin: it iterates the registry, dispatches, and maps errors. Every decision about *what* a tool does was made in plan 1.

**Stateless, with no Durable Object.** Cloudflare's `McpAgent` templates are deprecated for new servers, and stateless avoids both an extra binding and a class of session bugs. Concretely: a new `McpServer` and a new transport are constructed per request, used once, and discarded. There is no session id to track, no `GET` long-poll to hold open, and no state that can diverge between a client's view and the server's.

**Everything a tool advertises comes from the registry.** Name, description, input schema, and all three MCP annotations. Plan 1's Task 16 built the registry specifically so plan 2 would not have to write 28 schemas somewhere else, next to no tests, duplicating knowledge that lives there. If something is missing from what MCP needs to advertise, the fix goes in plan 1's registry.

**A failed tool call is a tool RESULT, not a protocol error.** This is the single most consequential design point in the file. MCP distinguishes a request the server could not process from a tool that ran and refused. A `not_found` is the latter: the model asked for a person who does not exist, the server understood perfectly, and the answer is "no such person - here is what to do instead." Returned as a JSON-RPC error, that becomes an exception the client surfaces as a failure and the model cannot act on. Returned as a result with `isError: true`, the model reads the code, reads the corrective next call, and does the right thing. Plan 1 built a seven-code error surface with a `next` field and structured `details` precisely so this could work, and flattening it here would throw all of that away at the last step.

**`ToolContext` is built per request** from the D1 binding, `OWNER_TIMEZONE`, and a real clock. Every date-shaped guarantee in plan 1 - due dates, `days_overdue`, the `today` envelope on every result - depends on the zone reaching this object.

- [ ] **Step 1: Write `src/mcp/errors.ts`**

```ts
import { ToolError } from "../errors";

/**
 * The seven codes crossing the transport boundary.
 *
 * A FAILED TOOL CALL IS A RESULT, NOT A PROTOCOL ERROR, and the difference
 * matters more here than anywhere else in this plan.
 *
 * MCP separates "the server could not process this request" from "the tool ran
 * and refused." A `not_found` is the second kind: the model asked for a person
 * who does not exist, the server understood perfectly, and the useful answer is
 * "no such person, and here is the call that would work." Thrown as a JSON-RPC
 * error, that reaches the client as an exception the model cannot act on.
 * Returned as a result, the model reads the code and the corrective next call
 * and fixes itself.
 *
 * Plan 1 built `next` and `details` onto ToolError specifically so this could
 * work. Flattening them into a message string here would discard that at the
 * last possible step.
 */
export function toolErrorResult(e: ToolError): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  const body = e.toResult();
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  };
}

/**
 * Anything that is NOT a ToolError is a bug in this server, and it is reported
 * as one without leaking what it was.
 *
 * A raw exception message can carry a SQL fragment with a person's name in it,
 * which would put PRM content into a transcript and, through the log line the
 * caller writes, into an observability dashboard.
 */
export function unexpectedErrorResult(requestId: string): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: {
              code: "internal",
              reason: "the tool failed unexpectedly; the operator can find this in the logs",
              request_id: requestId,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
```

- [ ] **Step 2: Write the failing test `tests/mcp.test.ts`**

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools/index";

/**
 * Calls the MCP endpoint directly, bypassing OAuth by invoking the handler with
 * props the provider would have supplied. The OAuth flow itself is covered by
 * Task 5 and, end to end, by Task 9 against a real deployment.
 */
async function rpc(method: string, params: unknown, props: unknown = { githubUserId: "583231" }) {
  const { mcpHandler } = await import("../src/mcp/transport");
  const { loadConfig } = await import("../src/config");
  const handler = mcpHandler(loadConfig(env), "r1");
  const request = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const response = await handler.fetch!(
    request,
    { ...env, props } as never,
    {} as ExecutionContext
  );
  return { response, body: await response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
});

describe("tools/list", () => {
  it("advertises all 28 tools from the registry", async () => {
    const { body } = await rpc("tools/list", {});
    const tools = (body.result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(28);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
  });

  it("carries each tool's schema and description straight from the registry", async () => {
    const { body } = await rpc("tools/list", {});
    const tools = (body.result as { tools: { name: string; description: string; inputSchema: unknown }[] }).tools;
    for (const tool of tools) {
      expect(tool.description, tool.name).toBe(TOOLS[tool.name]!.description);
      expect(tool.inputSchema, tool.name).toEqual(TOOLS[tool.name]!.inputSchema);
    }
  });

  it("carries ALL THREE MCP annotations, which is why plan 1 built them", async () => {
    // Clients use these to decide what to approve and what to run without
    // asking. A surface this size should not make a client guess.
    const { body } = await rpc("tools/list", {});
    const tools = (body.result as { name: string; annotations: Record<string, boolean> }[] | { tools: { name: string; annotations: Record<string, boolean> }[] });
    const list = "tools" in tools ? tools.tools : tools;
    for (const tool of list) {
      const expected = TOOLS[tool.name]!.annotations;
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expected.readOnlyHint,
        destructiveHint: expected.destructiveHint,
        idempotentHint: expected.idempotentHint,
      });
    }
  });
});

describe("tools/call", () => {
  it("runs a tool and returns its result", async () => {
    const { body } = await rpc("tools/call", {
      name: "create_person",
      arguments: { full_name: "Ada Lovelace" },
    });
    const result = body.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const person = JSON.parse(result.content[0]!.text);
    expect(person.full_name).toBe("Ada Lovelace");
    expect(person.id).toMatch(/^p_/);
  });

  it("carries `today` through, in the OWNER'S zone", async () => {
    // Applied at plan 1's registry seam. This asserts it survives the transport.
    const { body } = await rpc("tools/call", { name: "list_due", arguments: {} });
    const result = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(result.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a refusal as a RESULT, not a JSON-RPC error", async () => {
    // The single most consequential mapping in this file. As an error, the
    // model gets an exception it cannot act on. As a result, it reads the code
    // and the corrective next call and fixes itself.
    const { body } = await rpc("tools/call", {
      name: "get_person",
      arguments: { person_id: "p_00000000-0000-4000-8000-000000000000" },
    });
    expect(body.error).toBeUndefined();

    const result = body.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe("not_found");
  });

  it("preserves the corrective next call, which is why ToolError carries one", async () => {
    const { body } = await rpc("tools/call", {
      name: "get_roster_entry",
      arguments: { roster_entry_id: "re_00000000-0000-4000-8000-000000000000" },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(payload.error.next).toContain("list_roster_sources");
  });

  it("preserves structured details, so duplicate candidates survive the trip", async () => {
    await rpc("tools/call", {
      name: "create_person",
      arguments: { full_name: "Ada Lovelace", organization: "Kinsta" },
    });
    const { body } = await rpc("tools/call", {
      name: "create_person",
      arguments: { full_name: "Ada Lovelace", organization: "Kinsta" },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(payload.error.code).toBe("conflict");
    expect(Array.isArray(payload.error.details)).toBe(true);
    expect(payload.error.details[0].evidence).toContain("shared name");
  });

  it("maps an id of the wrong kind to invalid_id, not to a crash", async () => {
    const { body } = await rpc("tools/call", {
      name: "log_encounter",
      arguments: { person_id: "re_1", occurred_on: "2026-08-20", summary: "x" },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(payload.error.code).toBe("invalid_id");
  });

  it("reports an unknown tool without reaching the registry", async () => {
    const { body } = await rpc("tools/call", { name: "drop_everything", arguments: {} });
    expect(JSON.stringify(body)).toMatch(/unknown|not found/i);
  });

  it("NEVER leaks an internal exception message", async () => {
    // A raw exception can carry a SQL fragment with a person's name in it,
    // which would put PRM content into a transcript and a dashboard at once.
    const { body } = await rpc("tools/call", {
      name: "search_people",
      arguments: { query: "Ada", limit: 99999 },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    // A real refusal, with a real code - not a stack trace.
    expect(payload.error.code).toBe("limit_exceeded");
    expect(JSON.stringify(payload)).not.toMatch(/\bat .*\.ts:\d+/);
  });
});

describe("authorization", () => {
  it("REFUSES a valid token belonging to a different GitHub account", async () => {
    const { response } = await rpc("tools/list", {}, { githubUserId: "999999" });
    expect(response.status).toBe(403);
  });

  it("REFUSES a request whose grant carries no props", async () => {
    const { response } = await rpc("tools/list", {}, undefined);
    expect(response.status).toBe(403);
  });

  it("checks on tools/call as well as tools/list", async () => {
    const { response } = await rpc(
      "tools/call",
      { name: "create_person", arguments: { full_name: "Mallory" } },
      { githubUserId: "999999" }
    );
    expect(response.status).toBe(403);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("statelessness", () => {
  it("answers two independent requests with no session between them", async () => {
    // No Durable Object, no session id. Each request builds a server, uses it
    // once, and discards it.
    const first = await rpc("tools/list", {});
    const second = await rpc("tools/list", {});
    expect((first.body.result as { tools: unknown[] }).tools).toHaveLength(28);
    expect((second.body.result as { tools: unknown[] }).tools).toHaveLength(28);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run tests/mcp.test.ts`
Expected: FAIL, cannot resolve `../src/mcp/transport`.

- [ ] **Step 4: Write `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config";
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { logToolCall } from "../log";
import { TOOLS } from "../tools/index";
import { toolErrorResult, unexpectedErrorResult } from "./errors";

/**
 * Builds a server from plan 1's registry. Per request, and discarded after.
 *
 * EVERYTHING ADVERTISED COMES FROM THE REGISTRY - name, description, input
 * schema, and all three annotations. Plan 1's Task 16 built it that way
 * specifically so this file would not have to write 28 schemas next to no
 * tests. If MCP needs something the registry does not carry, the fix goes in
 * plan 1's registry, not here.
 */
export function buildServer(config: Config, env: Env, requestId: string): McpServer {
  const server = new McpServer(
    { name: "junco-prm", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Built once per request, from the deploy-time zone and a real clock. Every
  // date-shaped guarantee in plan 1 depends on this being right: due dates,
  // days_overdue, and the `today` envelope on every result.
  const ctx: ToolContext = {
    db: env.DB,
    timezone: config.ownerTimezone,
    clock: () => new Date(),
  };

  for (const tool of Object.values(TOOLS)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.name,
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          // Every tool here touches only this instance's own D1 database.
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const startedAt = Date.now();
        try {
          const result = await tool.run(ctx, args as never);
          logToolCall({
            requestId,
            tool: tool.name,
            durationMs: Date.now() - startedAt,
            outcome: "ok",
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          if (e instanceof ToolError) {
            logToolCall({
              requestId,
              tool: tool.name,
              durationMs: Date.now() - startedAt,
              outcome: "error",
              code: e.code,
            });
            return toolErrorResult(e);
          }
          // Not one of the seven codes, so it is a bug in this server. Logged
          // with a code the operator can grep for, and reported to the model
          // without the exception text - which can carry a SQL fragment with a
          // person's name in it.
          logToolCall({
            requestId,
            tool: tool.name,
            durationMs: Date.now() - startedAt,
            outcome: "error",
            code: "internal",
          });
          return unexpectedErrorResult(requestId);
        }
      }
    );
  }

  return server;
}
```

- [ ] **Step 5: Write `src/mcp/transport.ts`**

```ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { assertOwner, NotOwnerError } from "../auth/authorize";
import type { Config } from "../config";
import { buildServer } from "./server";

/**
 * STATELESS Streamable HTTP. No Durable Object, no session id, no held-open GET.
 *
 * Cloudflare's McpAgent templates are deprecated for new servers, and stateless
 * avoids both an extra binding and a class of session bugs. A new server and a
 * new transport are constructed per request, used once, and discarded -
 * `sessionIdGenerator: undefined` is what puts the SDK in that mode.
 */
export function mcpHandler(config: Config, requestId: string): ExportedHandler {
  return {
    async fetch(request, env): Promise<Response> {
      // AUTHORIZATION RUNS FIRST, ON EVERY REQUEST, before the body is parsed
      // and before any tool exists. workers-oauth-provider has validated the
      // bearer token it issued and put the grant's props on env; it explicitly
      // leaves the question of WHO that is to us.
      try {
        assertOwner(config, (env as { props?: unknown }).props, requestId);
      } catch (e) {
        if (e instanceof NotOwnerError) {
          return new Response(
            JSON.stringify({ error: "forbidden", request_id: requestId }),
            { status: 403, headers: { "content-type": "application/json" } }
          );
        }
        throw e;
      }

      const server = buildServer(config, env, requestId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      await server.connect(transport);
      return transport.handleRequest(request);
    },
  } satisfies ExportedHandler;
}
```

**A note for whoever implements this.** As with Task 5, the `@modelcontextprotocol/sdk` surface here - `registerTool`, `StreamableHTTPServerTransport`, and how `handleRequest` accepts a `Request` in a Workers runtime rather than a Node `req`/`res` pair - is the part of this plan most likely to have moved. **Read the installed package's types first**, and follow the package where it differs. The structure is what matters: authorize, build a server from `TOOLS`, connect a stateless transport, answer once. If the SDK's Workers story requires an adapter, that adapter belongs in this file and nowhere else.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/mcp.test.ts`
Expected: PASS.

The cases worth reading twice are the three under `tools/call` about error shape - "returns a refusal as a RESULT," "preserves the corrective next call," and "preserves structured details." Plan 1 spent real effort on a seven-code error surface with a `next` field and structured payloads, and all of it is only worth something if it survives this boundary. The `authorization` block is the other one: "checks on tools/call as well as tools/list" asserts that nothing was written, because a check that runs on the listing and not on the call is worse than no check at all.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/ tests/mcp.test.ts package.json package-lock.json
git commit -m "feat: serve the tool registry over stateless MCP"
```

---

### Task 8: Rate limiting the unauthenticated surface

**Files:**
- Create: `src/ratelimit.ts`
- Modify: `src/index.ts` - the limiter wraps the provider
- Modify: `wrangler.jsonc` - the `[[ratelimits]]` block, **only if Task 0 found it available**
- Test: `tests/ratelimit.test.ts`

**Interfaces:**
- Consumes: Plan 1 Task 0's finding, recorded in `docs/MEASUREMENTS.md` as `RATE_LIMIT_STRATEGY`.
- Produces:
  - `function checkRateLimit(env: Env, request: Request): Promise<boolean>` - the same signature either way
  - `function rateLimitedResponse(requestId: string): Response`

**Read `docs/MEASUREMENTS.md` before writing a line of this task.** Plan 1's Task 0 deployed a stub Worker to a free Cloudflare account with a `[[ratelimits]]` binding declared, and recorded whether the deploy was accepted. There are two implementations below and you build exactly one:

- `RATE_LIMIT_STRATEGY = "binding"` → the Workers rate-limiting binding.
- `RATE_LIMIT_STRATEGY = "kv_token_bucket"` → a token bucket over `OAUTH_KV`, which the deployment already has.

If `docs/MEASUREMENTS.md` does not exist or does not record this, **stop and run Task 0.** Building the wrong one is a wasted task plus a failed deploy, and guessing is exactly what Task 0 exists to prevent.

**Why this exists at all.** The OAuth authorization, token, dynamic-registration, and `/health` routes are reachable by anyone who finds the URL. Unlimited, they burn Worker requests, D1 reads, and the deployer's own GitHub application quota. Dynamic Client Registration is the sharpest edge: it is an unauthenticated write, so anyone who finds the URL can register clients in a loop, and each one costs a KV write.

**It wraps the provider's fetch handler, and that placement is not negotiable.** `workers-oauth-provider` serves `/authorize`, `/token`, and `/register` itself. A limiter sitting inside a tool handler never sees a single one of those routes - which is to say, it never sees any of the routes this task exists to protect. It sees only the authenticated surface, where there is exactly one legitimate user.

**Two honest caveats the spec states and this task inherits.** Cloudflare describes the binding as permissive and eventually consistent rather than exact, so this is protection against burning quota and not an accounting mechanism. And it runs *inside* the invocation, so it cannot protect the 100,000-requests-per-day Worker quota itself - only the D1 and GitHub work behind it. An attacker who simply wants to exhaust the day's request allowance can, and nothing in a Worker can stop that.

**Authenticated requests are not limited.** One deployment serves one person, and rate-limiting the owner's own tool calls would be limiting the only legitimate traffic on the instance. The limiter runs on the unauthenticated surface and lets `/mcp` through, where `assertOwner` is the gate.

- [ ] **Step 1: Write the failing test `tests/ratelimit.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, rateLimitedResponse } from "../src/ratelimit";

function requestFrom(ip: string, path = "/register") {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  });
}

beforeEach(async () => {
  // Only meaningful for the KV implementation; harmless for the binding one.
  const listed = await env.OAUTH_KV.list({ prefix: "rl:" });
  await Promise.all(listed.keys.map((k) => env.OAUTH_KV.delete(k.name)));
});

describe("checkRateLimit", () => {
  it("allows a first request", async () => {
    expect(await checkRateLimit(env, requestFrom("203.0.113.1"))).toBe(true);
  });

  it("REFUSES once a single client exceeds the burst", async () => {
    const request = requestFrom("203.0.113.2");
    let refused = false;
    for (let i = 0; i < 200; i++) {
      if (!(await checkRateLimit(env, request))) {
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
  });

  it("keys by client, so one abuser does not lock out the owner", async () => {
    const abuser = requestFrom("203.0.113.3");
    for (let i = 0; i < 200; i++) await checkRateLimit(env, abuser);
    expect(await checkRateLimit(env, requestFrom("203.0.113.4"))).toBe(true);
  });

  it("falls back to a fixed key when there is no client IP", async () => {
    // Must not throw, and must not treat every anonymous request as one client
    // sharing an `undefined` bucket silently - the fallback is explicit.
    const anonymous = new Request("https://example.test/register", { method: "POST" });
    expect(typeof (await checkRateLimit(env, anonymous))).toBe("boolean");
  });

  it("FAILS OPEN when the limiter itself errors", async () => {
    // A limiter outage must not take the instance down. The spec's own framing
    // is that this protects quota, not correctness - so an unavailable limiter
    // is a degraded instance, not a broken one. Deliberate, and the opposite
    // of every other failure decision in this plan.
    const broken = { ...env, OAUTH_KV: undefined, RATE_LIMITER: undefined } as never;
    expect(await checkRateLimit(broken, requestFrom("203.0.113.5"))).toBe(true);
  });
});

describe("rateLimitedResponse", () => {
  it("is a 429 carrying Retry-After", async () => {
    const response = rateLimitedResponse("r1");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("says nothing about whether this instance exists or is configured", async () => {
    const text = await rateLimitedResponse("r1").text();
    expect(text.toLowerCase()).not.toContain("junco");
    expect(text.toLowerCase()).not.toContain("github");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/ratelimit.test.ts`
Expected: FAIL, cannot resolve `../src/ratelimit`.

- [ ] **Step 3a: Write `src/ratelimit.ts` — the BINDING version**

Build this **only if** `docs/MEASUREMENTS.md` records `RATE_LIMIT_STRATEGY = "binding"`.

```ts
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
export async function checkRateLimit(env: Env, request: Request): Promise<boolean> {
  const limiter = env.RATE_LIMITER;
  if (!limiter) return true; // fail open - see below

  try {
    const { success } = await limiter.limit({ key: clientKey(request) });
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
```

And in `wrangler.jsonc`:

```jsonc
{
  "ratelimits": [
    { "name": "RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }
  ]
}
```

Sixty requests a minute per IP against the unauthenticated surface. A legitimate OAuth flow is a handful of requests; sixty is generous enough that nobody real will ever see a 429, and low enough that a registration loop stops being free.

- [ ] **Step 3b: Write `src/ratelimit.ts` — the KV TOKEN BUCKET version**

Build this **only if** `docs/MEASUREMENTS.md` records `RATE_LIMIT_STRATEGY = "kv_token_bucket"`, meaning Task 0 found the binding unavailable on a free plan.

```ts
const WINDOW_SECONDS = 60;
const LIMIT_PER_WINDOW = 60;

/**
 * A fixed-window counter over the KV namespace the deployment already has.
 *
 * The fallback the spec names for the case where the ratelimits binding is not
 * available on a free plan. It is WEAKER than the binding, and honestly so:
 *
 *  - KV is eventually consistent, so a burst arriving at several edge locations
 *    at once can each see a stale count and all pass.
 *  - Read-then-write is not atomic, so concurrent requests within one location
 *    can lose an increment.
 *  - It is a fixed window, not a sliding one, so twice the limit can pass
 *    across a window boundary.
 *
 * None of that matters much for what this is actually for. The threat is a loop
 * burning D1 reads, KV writes, and the deployer's GitHub quota, and a counter
 * that is approximately right stops a loop just as well as an exact one. It is
 * written down because the next reader will otherwise assume it is a real
 * limiter and rely on it for something it cannot do.
 */
export async function checkRateLimit(env: Env, request: Request): Promise<boolean> {
  if (!env.OAUTH_KV) return true; // fail open

  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `rl:${clientKey(request)}:${window}`;

  try {
    const current = Number((await env.OAUTH_KV.get(key)) ?? "0");
    if (current >= LIMIT_PER_WINDOW) return false;

    // expirationTtl is what keeps this from accumulating a key per client per
    // minute forever. Two windows of slack so a late write cannot outlive it.
    await env.OAUTH_KV.put(key, String(current + 1), {
      expirationTtl: WINDOW_SECONDS * 2,
    });
    return true;
  } catch {
    // FAIL OPEN. See the note in the binding version: a limiter outage should
    // degrade the instance, not take it down.
    return true;
  }
}

function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export function rateLimitedResponse(requestId: string): Response {
  return new Response(JSON.stringify({ error: "rate_limited", request_id: requestId }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(WINDOW_SECONDS) },
  });
}
```

- [ ] **Step 4: Wrap the provider in `src/index.ts`**

The limiter goes **around** the provider, not inside anything it serves. Insert between the config check and the provider call:

```ts
    // WRAPS THE PROVIDER. workers-oauth-provider serves /authorize, /token, and
    // /register itself, so a limiter behind it never sees the routes this
    // exists to protect.
    //
    // /mcp is exempt: one deployment serves one person, and rate-limiting the
    // owner's own tool calls would throttle the only legitimate traffic here.
    // assertOwner is the gate on that path.
    if (url.pathname !== "/mcp" && !(await checkRateLimit(env, request))) {
      return finish(rateLimitedResponse(requestId));
    }

    const provider = buildProvider(config, mcpHandler(config, requestId));
    return finish(await provider.fetch(request, env, ctx));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ratelimit.test.ts`
Expected: PASS.

The "FAILS OPEN when the limiter itself errors" case is the one to read carefully, because it runs against the grain of every other failure decision in this plan. Task 1 fails closed on missing configuration; this fails open on a broken limiter. The difference is what each protects: configuration protects the data, and a limiter protects a bill.

- [ ] **Step 6: Record which one you built**

Append to `docs/MEASUREMENTS.md` under Rate limiting, so the next reader does not have to infer it from the source:

```markdown
- Implementation built: <binding | kv_token_bucket>
- Built on: <date>
```

- [ ] **Step 7: Commit**

```bash
git add src/ratelimit.ts src/index.ts wrangler.jsonc tests/ratelimit.test.ts docs/MEASUREMENTS.md
git commit -m "feat: rate limit the unauthenticated surface"
```

---

### Task 9: The authenticated end-to-end run against a real deployment

**Files:**
- Create: `tests/deployed.md` - a checklist, not a test file
- Test: none automatable. That is the point of this task.

**Interfaces:**
- Consumes: everything.
- Produces: a deployed, working Junco PRM instance connected to Matt's Claude account, and a record of what was checked.

**This is a checklist rather than a test file because no runner can drive it.** The spec is direct about why: local tests cannot exercise Dynamic Client Registration, the consent screen, or token refresh, **which is where a connector actually fails.** Everything up to here has been proven against `workerd` with mocked GitHub responses. This task is the first time the real thing runs.

**Matt runs the deploy steps.** They need a Cloudflare account, a GitHub OAuth App, and a Claude client, and none of those can be driven from a test runner. The agent's job is to have made every command correct and every value known in advance.

**This is also a rehearsal for plan 3.** The runbook plan 3 writes is this sequence, generalized for a stranger and with the reasoning attached. Anything that goes wrong here is a defect in that future runbook, discovered before it lands on someone who did not build the thing - so record surprises as they happen rather than fixing them silently.

**One expectation worth setting before starting.** The supported order is deploy, add the connector on claude.ai or Claude Desktop, and only then use it from a phone. Web connectors work on Claude Mobile for iOS and Android, but *installing* one from mobile is in beta and Anthropic names Desktop and the web as the primary path. Starting on the phone may work and may hit a wall; do not start there.

Two more, so they are not discovered as surprises: free-plan Claude accounts are limited to one custom connector, and on Team and Enterprise plans only an organization owner can add one at all.

- [ ] **Step 1: Write `tests/deployed.md`**

The checklist below is the file. It is committed so the next person - which may be Matt in six months - can re-run it after a change, and so plan 3 has something concrete to generalize from.

````markdown
# Deployed end-to-end check

Run against a real deployment through a real Claude client. Re-run after any
change to authentication, the transport, or the tool registry.

Local tests cannot cover any of this: Dynamic Client Registration, the consent
screen, and token refresh have no local equivalent, and they are where a
connector actually fails.

## Before starting

- [ ] A Cloudflare account, signed in via `wrangler login`
- [ ] A GitHub **OAuth App** (Developer settings → OAuth Apps → New OAuth App).
      Not a GitHub App - different flow, different token model, and the
      interface pushes the wrong one harder.
- [ ] `docs/MEASUREMENTS.md` exists and records `RATE_LIMIT_STRATEGY`
- [ ] Plan 1's full suite passes and `npm run typecheck` is clean

## Deploy

- [ ] `npx wrangler d1 create junco-prm` — paste the `database_id` into `wrangler.jsonc`
- [ ] `npx wrangler kv namespace create OAUTH_KV` — paste the `id` into `wrangler.jsonc`
- [ ] `npx wrangler d1 migrations apply junco-prm --remote`
- [ ] Resolve the numeric GitHub user id:
      `curl -s https://api.github.com/users/<username> | grep '"id"'`
      Set it as `OWNER_GITHUB_USER_ID` in `wrangler.jsonc`. **Numeric, not the username.**
- [ ] Set `OWNER_TIMEZONE` in `wrangler.jsonc` (e.g. `America/Los_Angeles`)
- [ ] Set `GITHUB_CLIENT_ID` in `wrangler.jsonc`
- [ ] `npx wrangler secret put GITHUB_CLIENT_SECRET`
- [ ] `npx wrangler secret put COOKIE_ENCRYPTION_KEY`
      Generate with: `openssl rand -hex 32`
- [ ] `npx wrangler deploy` — note the deployed URL

## Set the GitHub callback

- [ ] In the OAuth App settings, set **Authorization callback URL** to
      `<deployed-url>/callback` — the full URL, not the bare Worker origin.
      A bare origin fails at consent time with an unhelpful error.

## Verify the Worker before involving Claude

- [ ] `curl -s <deployed-url>/health` returns `status: ok`
- [ ] It reports the expected `schema_version` (the last migration file name)
- [ ] It reports `configured: true`
- [ ] It reveals no owner id, no client id, and no counts
- [ ] `curl -s <deployed-url>/.well-known/oauth-authorization-server` returns
      metadata naming `/authorize`, `/token`, and `/register`
- [ ] `curl -s -o /dev/null -w '%{http_code}' <deployed-url>/mcp` returns 401,
      not 200 and not 500 — the endpoint exists and refuses anonymous callers

## Fail-closed check, before there is any data to lose

- [ ] Temporarily break one secret: `npx wrangler secret put GITHUB_CLIENT_SECRET`
      with an empty value, then `npx wrangler deploy`
- [ ] `curl -s -o /dev/null -w '%{http_code}' <deployed-url>/authorize` returns 503
- [ ] `/health` still answers, and now reports `configured: false`
- [ ] Restore the real secret and redeploy; `/health` reports `configured: true`

## Connect Claude

- [ ] On **claude.ai or Claude Desktop** (not mobile), add a custom connector
      pointing at `<deployed-url>/mcp`, named `Junco PRM`
- [ ] The GitHub consent screen appears on first connect
- [ ] It requests **no scopes** — if it asks for `read:user` or anything else,
      stop: `authorizeUrl` is sending a scope parameter it should not
- [ ] Approving it returns to Claude and the connector shows as connected
- [ ] The connector lists **28 tools**

## Use it

- [ ] "Add Ada Lovelace, she works at Kinsta" creates a person
- [ ] "Add Ada Lovelace at Kinsta" again is **refused** with duplicate candidates
- [ ] "What's today's date according to my PRM?" answers in **your** time zone,
      not UTC — check this near midnight if you can, it is the whole reason
      `OWNER_TIMEZONE` exists
- [ ] "I met her at the hallway track, she owes me a compiler" logs an encounter
- [ ] "Remind me to send her the deck by Friday" creates a follow-up
- [ ] "What am I forgetting?" lists it
- [ ] "Who do I know at Kinsta?" finds her
- [ ] Ask for a person who does not exist — the answer is a useful refusal the
      model can act on, **not** a raw error or a crash

## Reject a stranger

- [ ] Change `OWNER_GITHUB_USER_ID` in `wrangler.jsonc` to any other number and
      `npx wrangler deploy`
- [ ] The next tool call from Claude fails — **immediately**, without removing
      the connector or waiting for anything to expire. This is the revocation
      story the spec tells, and it works because the check compares against the
      current variable rather than against anything stored.
- [ ] `npx wrangler tail` shows an `auth_failure` line carrying the presented
      numeric id
- [ ] Restore the real id and redeploy; the connector works again without being
      re-added

## Check the logs are safe to read

- [ ] `npx wrangler tail` while running a few tool calls
- [ ] Lines carry tool name, duration, outcome, and a request id
- [ ] **No name, note text, organization, contact detail, or token appears
      anywhere.** This is the check that makes observability safe to leave on.

## Mobile

- [ ] Open Claude on the phone, with the connector already added from the web
- [ ] The tools are available and a `log_encounter` works
- [ ] This is the requirement that drove the entire hosting decision, so it is
      worth confirming rather than assuming

## Record

- [ ] Note the date, the deployed URL, and anything that surprised you.
      Surprises are defects in plan 3's runbook, found before a stranger finds
      them.
````

- [ ] **Step 2: Matt runs the checklist**

The agent's job at this point is done except for fixing what the checklist finds. Work through it in order - the Worker checks come before Claude is involved deliberately, so that a failure has one plausible cause rather than three.

- [ ] **Step 3: Fix what it finds, then re-run the affected section**

A defect found here belongs to whichever task owns it - a scope appearing on the consent screen is Task 4, a leaked field in a log line is Task 2 - and the fix goes there with a test, not as a patch at the edge.

- [ ] **Step 4: Commit**

```bash
git add tests/deployed.md
git commit -m "test: add the deployed end-to-end checklist"
```

---

## Verification

Run once every task is complete. Nothing here is optional.

- [ ] **Plan 1's verification section still passes.** Plan 2 modified `src/index.ts` and nothing else under `src/tools/`; if a plan 1 test now fails, plan 2 reached somewhere it should not have.
- [ ] **Full suite green:** `npm test` passes with no skipped tests.
- [ ] **Types clean:** `npm run typecheck` reports no errors.
- [ ] **No PRM content can reach a log:** `grep -rn "console\." src/` returns hits in `src/log.ts` and nowhere else.
- [ ] **No second tool schema exists:** `grep -rn "inputSchema" src/mcp/ src/auth/` shows the schema being *read* from `TOOLS`, never defined. Every tool's name, description, schema, and annotations come from plan 1's registry.
- [ ] **The upstream token is never persisted:** `grep -rn "access_token" src/` shows it only inside `src/auth/github.ts`, and never in an object that reaches `props`, KV, or a log.
- [ ] **No scope is ever requested:** `grep -n "scope" src/auth/github.ts` shows no `searchParams.set("scope", ...)`.
- [ ] **`login` is never read as an identity:** `grep -rn "\.login" src/` returns nothing.
- [ ] **Authorization runs before any tool:** `assertOwner` is the first statement in `mcpHandler`'s fetch, before the body is parsed.
- [ ] **No Durable Object:** `grep -n "durable_objects" wrangler.jsonc` returns nothing, and `grep -rn "McpAgent" src/` returns nothing.
- [ ] **Secrets are not committed:** `grep -n "CLIENT_SECRET\|COOKIE_ENCRYPTION_KEY" wrangler.jsonc` returns nothing. Both are `wrangler secret put` values.
- [ ] **The deployed checklist has been run end to end** and its surprises recorded.

## What this plan does not build

Named so a reviewer does not read the absence as an oversight.

- **No deploy runbook.** Plan 3. Task 9's checklist is a rehearsal for it and is deliberately written for someone who built the thing, not for a stranger.
- **No `docs/UPGRADE.md`.** Plan 3. The `/health` schema version this plan builds is what that document checks against.
- **No CLI export and no restore drill.** Plan 3.
- **No second identity provider, and no seam for one.** The spec is explicit: an interface with one implementation, written against a second that may never exist, is worse than one findable module. If a second provider is ever added, the interface gets extracted then, against two real cases.
- **No local stdio adapter.** The spec defers it to "later, only if wanted." The tool layer stays transport-agnostic so it remains cheap, and this plan does nothing that would make it harder.
- **No handling of a database reaching the 500 MB free-plan limit.** This is a real gap, carried forward from the spec's own deferred findings, and it is named here rather than left to be discovered. Nothing in phase 1 detects it, warns about it, or degrades gracefully when it happens.
- **No per-tool rate limiting or quota.** One deployment serves one person; the limiter guards the unauthenticated surface, and the owner's own tool calls are unthrottled.

## Decisions taken while writing this plan

Four things the spec left to the implementer. Recorded with their reasoning, because each is a place a later reader will otherwise wonder what was weighed.

- **`ALLOWED_REDIRECT_HOSTS` is `claude.ai` and `claude.com`, matched on host rather than on Anthropic's exact documented callback URL.** Exact-URL matching would break on a path change with no way to fix it but a redeploy; host matching still refuses a registration pointing anywhere else. Loopback over http is accepted as the standard OAuth native-app exception, because Desktop and inspector clients need it.
- **`CLIENT_REGISTRATION_TTL_SECONDS` is one year, revised up from 90 days while this plan was being reviewed.** The spec says a long-lived personal instance has to choose this deliberately rather than inherit it, and gives no number. The first draft picked 90 days on the reasoning that DCR is an unauthenticated write and registrations should not accumulate. That reasoning does not survive examination: a registration loop's real cost is KV *writes*, which are capped daily and are bounded by the rate limiter, while a TTL reclaims only *storage*. So the short TTL was defending something already defended, at the cost of a failure that lands on the owner - a connector that stops working with no message saying why. The asymmetry favors a long TTL. **This is still not fully settled:** what a client experiences when its registration lapses is unverified, and Task 5 carries an instruction to check it during implementation and record the answer.
- **`OWNER_GITHUB_USER_ID` is a plain variable, not a secret.** It is a public number anyone can resolve from a username. Making it a secret would hide it from deploy output and the dashboard, which is exactly where an operator needs to see it when debugging why their own requests are refused.
- **The rate limiter fails OPEN, against the grain of everything else in this plan.** Task 1 fails closed on missing configuration; the limiter fails open on its own errors. The difference is what each protects: configuration protects the data, and the limiter protects a bill. Refusing every request because a counter is unavailable is worse than the quota being spent.

## Findings sent back up to the spec

Nothing in this plan contradicts the spec. Two things it does not currently say, which it should:

- **The spec does not name the environment variables.** It names `OAUTH_KV` and `OWNER_TIMEZONE` and describes the others in prose. This plan pins `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, and `OWNER_GITHUB_USER_ID`, and plan 3's runbook will depend on those exact names. Worth folding into the spec's Deployment section so the runbook and the code have one source for them.
- **The spec's "identity echo" removal left no statement of how an operator recovers from setting `OWNER_GITHUB_USER_ID` wrong.** The answer this plan produces is good - `/health` reports `configured: true` because a wrong-but-numeric id is valid, and the operator sees an `auth_failure` line in `wrangler tail` carrying the id that *was* presented, which is exactly the number they should have set. That is a genuinely nice recovery path and it happens to work rather than having been designed. It should be written down in Operations, under Losing access.
