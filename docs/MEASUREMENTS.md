# Measurements

Constants in this project that were measured rather than derived. Each entry
records the date, the plan the account was on, and the observation, because a
Cloudflare limit can change and a number with no provenance cannot be rechecked.

Reproduce any of this with the throwaway Worker in `spike/`. See plan 1, Task 0.

---

## Run of 2026-08-24

- **Account plan: Cloudflare Workers Free.** Confirmed in the dashboard; the $5
  Workers Paid tier was shown as an available upgrade, not as the current plan.
  This matters more than any other line in this file: the whole point of the
  measurement is what a stranger deploying their own instance will hit, and a
  paid-plan number would not transfer.
- Wrangler 4.125.0, `compatibility_date` 2026-08-01
- D1 database `junco-prm-spike`, region WNAM
- CPU figures read from `wrangler tail`, never from inside the Worker: `Date.now()`
  is frozen between I/O in Workers, so a compute loop cannot time itself.

### Question 1: does a `db.batch()` of N statements spend N queries or one?

**Answer: not N.** Every size tested succeeded, well past the printed cap.

| statements | outcome | CPU (ms) |
|---:|---|---:|
| 49 | ok | 0 |
| 50 | ok | 2 |
| 60 | ok | 3 |
| 200 | ok | 1 |
| 500 | ok | 3 |

Each size was run in its own invocation, twice, and the second run is reported -
the first invocation after a deploy pays cold-start cost that is not part of the
answer.

**Consequence: the withdrawn derivation was wrong in the direction that mattered,
and the D1 query budget does not bound an import chunk.** Cloudflare's Workers
limits page lists 50 external subrequests against 1,000 to internal services, and
D1 is an internal service; D1's own limits page prints 50 queries per invocation.
The observation matches the first reading. 500 statements inside one `batch()`
went through with 3 ms of CPU and no error.

**Still true and still binding: 100 bound parameters per statement.**
`roster_entries` has 16 columns, so `UPSERT_ROWS_PER_STATEMENT` stays at 6. That
figure was never in question and is unaffected.

### Question 2: how much CPU does one roster row cost?

**Answer: ~0.033 ms.** And the limit it was being measured against does not
exist as documented.

Each row is normalized field by field, canonicalized twice, and hashed twice -
once over the identity subset for `external_row_key`, once over the whole row for
`content_hash` - against a row carrying a 400-character bio.

| rows | CPU (ms) | wall (ms) | ms/row |
|---:|---:|---:|---:|
| 10 | 2 | 3 | - |
| 25 | 1 | 2 | - |
| 50 | 5 | 6 | - |
| 100 | 18 | 26 | - |
| 150 | 11 | 13 | - |
| 300 | 11 | 12 | - |
| 600 | 25 | 27 | 0.042 |
| 1200 | 45 | 49 | 0.038 |
| 2500 | 84 | 86 | 0.034 |
| 5000 | 163 | 168 | 0.033 |

The small sizes are noise: V8 has not warmed up, and `wrangler tail` reports CPU
as whole milliseconds, so anything under ~50 rows is below the resolution of the
instrument. The three largest samples agree closely and are the trustworthy ones.

**THE SPEC'S 10 ms FREE-PLAN CPU LIMIT IS STALE.** A 5000-row invocation spent
**163 ms of CPU and completed**, on a free account. No ceiling was found; the
probe stops at 5000 because that is where the spike's input validation caps it,
not because anything failed. Two smaller runs had already exceeded 10 ms without
being killed, so this is not a boundary effect.

**Consequence: nothing on the platform bounds the import chunk any more.** At
0.033 ms/row, a 150-row chunk costs about 5 ms of CPU and 25 upsert statements -
both of which the measurements above show are far inside what a free invocation
survives. Even 500 rows would be ~17 ms and 84 statements.

### Question 3: is the `[[ratelimits]]` binding available on a free plan?

**Answer: yes.**

The binding was declared in `spike/wrangler.jsonc`, `wrangler deploy` accepted it
and listed it - `env.SPIKE_LIMIT (100 requests/60s)  Rate Limit` - and it is
present and functional at runtime:

```json
{ "question": "ratelimit binding", "bound": true, "first_call_success": true }
```

**`RATE_LIMIT_STRATEGY = "binding"`.** Plan 2 Task 8 builds the Workers
rate-limiting binding, not the KV token-bucket fallback. The reviewer who
believed it was paid-only and would fail the deploy was mistaken.

Note for anyone re-running this: a local `wrangler dev` reports `bound: true`
regardless, because Miniflare simulates the binding. Only a remote deploy answers
this question.

---

## Run of 2026-08-24, second: cascaded deletes and FTS triggers

Not a Cloudflare measurement. Run locally against **SQLite 3.51.0** with
`foreign_keys = ON` and `recursive_triggers = OFF`, to settle a claim the spec
and plan 1 both asserted.

**The claim, now withdrawn:** that rows removed by an `ON DELETE CASCADE` may not
fire the `AFTER DELETE` triggers maintaining the FTS indexes, so `delete_person`
must delete children explicitly or a deleted person's text stays searchable.

**The observation: cascaded deletes DO fire the triggers.** A parent row was
deleted, the child row went with it by cascade, and the child's FTS row was
removed by the trigger. The reasoning behind the original claim misread a real
sentence in SQLite's documentation - foreign key actions are unaffected by the
recursive-triggers setting - which means those actions happen regardless of the
setting, not that they bypass triggers.

**What did not change:** `delete_person` still deletes children explicitly. The
reasons are now weaker and stated as such - D1 runs its own SQLite build inside
workerd and this was not tested there, and an explicit delete states intent at
the call site. Plan 1 Task 8 Step 5c records what to check against D1 itself.

**Still not established here:** whether D1's build behaves the same way.
Nobody had run this inside workerd yet. See the fourth run below, from
Task 10 Step 7c, which checks it.

---

## Run of 2026-08-24, third: library APIs

Not a measurement of anything, just reading installed types instead of trusting
recollection. Done after a four-agent review of plan 2 found that three of the
four options passed to `OAuthProvider` do not exist.

Versions installed to check: **`@cloudflare/workers-oauth-provider` 0.10.3**,
**`@modelcontextprotocol/sdk` 1.30.0**.

### `workers-oauth-provider`

The complete option set on `OAuthProviderOptions`: `apiRoute`, `apiHandler`,
`apiHandlers`, `defaultHandler`, `authorizeEndpoint`, `tokenEndpoint`,
`clientRegistrationEndpoint`, `accessTokenTTL`, `refreshTokenTTL`,
`clientRegistrationTTL`, `scopesSupported`, `allowImplicitFlow`,
`allowPlainPKCE`, `allowTokenExchangeGrant`, `enterpriseManagedAuthorization`,
`disallowPublicClientRegistration`, `clientRegistrationCallback`,
`tokenExchangeCallback`, `resolveExternalToken`, `onError`.

Three names plan 2 used are **not among them**: `cookieSecret`,
`allowedRedirectUriHosts`, and `clientRegistrationTtlSeconds`. The TTL option is
`clientRegistrationTTL`. There is no cookie option at all - the library does not
manage a consent cookie, which means `COOKIE_ENCRYPTION_KEY` had no consumer and
the application has to do its own cookie handling. Redirect policy belongs in
`clientRegistrationCallback`, which receives `{ clientMetadata, request }`.

**Grant props reach a protected handler as `ctx.props`, not `env.props`.** The
README is explicit that the provider validates the bearer token and exposes the
application data through `ctx.props`, and equally explicit that the handler
"must still enforce application permissions such as scope, ownership, and
tenancy" - which is what `assertOwner` is for.

### `@modelcontextprotocol/sdk`

`WebStandardStreamableHTTPServerTransport` exists, in
`server/webStandardStreamableHttp.js`, and its `handleRequest(req: Request,
options?): Promise<Response>` is exactly the shape a Worker needs.
`StreamableHTTPServerTransport`, which plan 2 originally named, is the Node
transport built on `IncomingMessage`/`ServerResponse`. Both take
`sessionIdGenerator` and `enableJsonResponse`.

`McpServer.registerTool` takes a Zod raw shape, **not** a JSON Schema object, so
plan 1's registry cannot feed it directly. But the wire-level `ToolSchema` in
`types.d.ts` declares `inputSchema` as `{ type: "object", properties?, required?
}` - which is exactly the shape plan 1 already produces. So the low-level
`Server` with `setRequestHandler(ListToolsRequestSchema, ...)` passes the
registry through untouched, with no adapter and no second schema. That is both
the working path and a better fit for plan 2's own rule that everything
advertised comes from the registry.

### The lesson worth keeping

Every one of these was written from recollection and stated with confidence.
Reading two `.d.ts` files took a few minutes and would have prevented all of
them. **This is the third time in one day** that something asserted here as fact
turned out wrong - after the free-plan CPU limit and the SQLite cascade claim -
and it is the only one of the three that could have been checked without
deploying anything.

---

## Constants this run set

| Constant | Value | Bounded by |
|---|---|---|
| `IMPORT_BATCH_LIMIT` | 150 | **Not the platform.** See below. |
| `UPSERT_ROWS_PER_STATEMENT` | 6 | 100 bound parameters ÷ 16 columns. Unchanged. |
| `KEY_LOOKUP_CHUNK` | 99 | The same parameter cap. Unchanged. |
| `RATE_LIMIT_STRATEGY` | `"binding"` | Question 3. |

**`IMPORT_BATCH_LIMIT` keeps its value and loses its justification.** It was
always 150, first as a derivation from the D1 query budget and then as a
placeholder pending this measurement. Both platform limits it was meant to
respect turn out not to bind at any chunk size this protocol would use.

What bounds it now is **the model, not the runtime**: a chunk is roster rows a
language model has to emit as JSON in a single tool call, at roughly 50 to 100
tokens per row. 150 rows is 7,500 to 15,000 tokens of tool input, which is a
sensible amount to ask a model to produce in one call and to re-produce if the
call has to be retried. 500 rows would be 25,000 to 50,000, which is not.

That is a real constraint and worth stating plainly, but it is a judgment about
model behavior rather than a measured platform limit, and this file should not
pretend otherwise. The number is unchanged; the reason it is that number is
entirely different, and a future reader raising it should be arguing about tool
call size rather than about Cloudflare.

---

## Run of 2026-08-24, fourth: D1's own SQLite build, cascades and FTS triggers

Task 10 Step 7c. Run against `tests/people-lifecycle.test.ts`'s hard-delete FTS
test (extended in Task 10 to also seed and check an encounter) via
`@cloudflare/vitest-pool-workers`, which runs the test inside workerd against
D1's own SQLite build - not the local SQLite 3.51 used for the second run
above.

**Method:** the explicit `DELETE FROM encounters WHERE person_id = ?` in
`delete_person` was commented out, leaving only the `ON DELETE CASCADE` on
`encounters.person_id`, and the extended test was run against that.

**The observation: it passed.** The cascade alone removed the encounter, and
the `encounters_fts_ad` trigger fired and removed its FTS row - same outcome
as the second run's local SQLite test. D1's build, at least as exposed through
this test harness, does not diverge from stock SQLite on this point.

**What did not change:** the explicit delete was restored immediately after
this measurement, per Task 10 Step 7c's instruction not to treat a pass as a
reason to remove it. It is now measured as defense in depth on both SQLite
builds available to check, rather than on local SQLite alone.

**Caveat:** `vitest-pool-workers` is Cloudflare's own test harness for D1 and
is the closest thing to "inside workerd" available without a real deploy, but
it is still not a production D1 database on Cloudflare's network. Whether a
deployed D1 instance behaves identically remains unconfirmed.

---

## Rate limiting

Plan 2 Task 8, against `RATE_LIMIT_STRATEGY = "binding"` recorded above.

- Implementation built: binding
- Built on: 2026-08-25

Two `[[ratelimits]]` bindings, per the ruling that both the OAuth/health surface
and `/mcp` burn quota when hit anonymously: `RATE_LIMITER` (60/60s) wraps
`workers-oauth-provider`'s own routes and `/health`; `MCP_RATE_LIMITER` (600/60s)
covers `/mcp`. Both sit ahead of the provider in `src/index.ts`, above the
`/health` branch, so nothing below - including the routes the provider serves
itself - is reachable before the check runs.

**A defect found in this task's own brief:** the produced interface,
`checkRateLimit(env, request, bucket)`, listed `bucket` as a required parameter,
but the brief's own verbatim `tests/ratelimit.test.ts` calls it with two
arguments in five of its seven cases. `tsc --noEmit` fails on that file against
a required third parameter (`Expected 3 arguments, but got 2`). `bucket`
defaults to `"public"` in the shipped code, which makes the brief's test file
typecheck and matches every production call site in `src/index.ts`, which
always passes `bucket` explicitly.

## What was NOT established

- **The actual free-plan CPU ceiling.** The probe found no failure up to 163 ms
  and stopped there. Someone who needs the real number should raise the spike's
  input cap above 5000 and keep going.
- **Whether any of this holds on a different account or region.** One account,
  one D1 region (WNAM), one day.
- **Whether `batch()` has an upper bound on statement count at all.** 500 worked.
  Larger was not tried, because no plausible chunk needs it.
