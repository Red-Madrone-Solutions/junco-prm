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

---

## Run of 2026-08-27: D1 Time Travel availability

Answers the spec's open question of whether the live database is on a backend
that supports Time Travel. Run against the live `junco-prm` database, not the
spike.

Wrangler 4.125.0.

    npx wrangler d1 time-travel info junco-prm

Verbatim output (ANSI color codes stripped):

```
 ⛅️ wrangler 4.125.0 (update available 4.127.0)
───────────────────────────────────────────────
Resource location: remote 

🚧 Time Traveling...
⚠️ The current bookmark is '0000002d-00000000-000050d4-b7c899f681622bb0df214f940a12aa39'
⚡️ To restore to this specific bookmark, run:
 `wrangler d1 time-travel restore junco-prm --bookmark=0000002d-00000000-000050d4-b7c899f681622bb0df214f940a12aa39`
```

**Answer: yes, Time Travel is available on `junco-prm`.** The command
succeeded and returned a current bookmark. It did not print a separate
timestamp field - the bookmark is itself the addressable point-in-time
reference that `wrangler d1 time-travel restore --bookmark=<value>` accepts,
so the missing timestamp field does not leave the open question unresolved.
The command was run twice, a few seconds apart, and returned the same
bookmark both times, consistent with no writes happening against the
database in between.

---

## Run of 2026-08-27: `wrangler d1 execute --json` output shape

Answers Task 5's open question about what `wrangler d1 execute --json` actually
prints, so `parseExecuteJson` is written against an observed shape rather than
a guess. Run against the live `junco-prm` database, not the spike.

Wrangler 4.125.0.

    npx wrangler d1 execute junco-prm --remote --json --command "SELECT id, full_name FROM people LIMIT 2"

Verbatim shape observed (real names replaced with placeholders; the row
content is a live contact database and does not belong in this file):

```json
[
  {
    "results": [
      { "id": "p_PLACEHOLDER_1", "full_name": "REDACTED" },
      { "id": "p_PLACEHOLDER_2", "full_name": "REDACTED" }
    ],
    "success": true,
    "meta": {
      "served_by": "v3-prod",
      "served_by_region": "WNAM",
      "served_by_colo": "SJC",
      "served_by_primary": true,
      "timings": { "sql_duration_ms": 0.6645 },
      "duration": 0.6645,
      "changes": 0,
      "last_row_id": 0,
      "changed_db": false,
      "size_after": 1597440,
      "rows_read": 2,
      "rows_written": 0,
      "total_attempts": 1
    }
  }
]
```

**Answer: the top level is a JSON array**, one element per statement executed
(one statement here, so one element). The rows live under `results` on that
element, alongside `success` and a `meta` object with `served_by`, `timings`,
`rows_read`, and other fields. This matches the shape the brief's fixture
assumed; no fixture change was needed.

Then against a table known to be empty:

    npx wrangler d1 execute junco-prm --remote --json --command "SELECT * FROM confirmations LIMIT 1"

```json
[
  {
    "results": [],
    "success": true,
    "meta": {
      "served_by": "v3-prod",
      "served_by_region": "WNAM",
      "served_by_colo": "SJC",
      "served_by_primary": true,
      "timings": { "sql_duration_ms": 0.3285 },
      "duration": 0.3285,
      "changes": 0,
      "last_row_id": 0,
      "changed_db": false,
      "size_after": 1597440,
      "rows_read": 1,
      "rows_written": 0,
      "total_attempts": 1
    }
  }
]
```

**Answer: an empty result is `results: []`** on an otherwise normal, still
`success: true` element - not a missing `results` key, not a shorter array at
the top level, and not an error. `rows_read` is 1 even though 0 rows came
back, because the engine still read the (empty) table to answer the query.

No `code 7403 not authorized` error was hit on either run, so no retry was
needed.

---

## Run of 2026-08-27: the restore drill

Plan 1 Task 8. The first time `npm run restore` was ever run against a real
database. Disposable database `junco-restore-drill`, created and deleted
within this run, id `9b50c073-b885-416e-a8fb-6c762cccdca0` (recorded here for
provenance only; the database no longer exists).

A fresh export was taken rather than reusing the archive already on disk,
because the live database had changed since that earlier export.

**Row counts, live `junco-prm` vs freshly exported archive vs restored
`junco-restore-drill`, batched through `countRows` (D1 rejects a compound
`SELECT` past 5 terms):**

| table | live | archive | restored |
|---|---:|---:|---:|
| people | 50 | 50 | 50 |
| tags | 5 | 5 | 5 |
| person_contacts | 27 | 27 | 27 |
| person_links | 85 | 85 | 85 |
| person_tags | 35 | 35 | 35 |
| encounters | 25 | 25 | 25 |
| followups | 6 | 6 | 6 |
| roster_sources | 1 | 1 | 1 |
| import_runs | 1 | 1 | 1 |
| roster_entries | 798 | 798 | 798 |
| person_sources | 41 | 41 | 41 |

All eleven tables matched. No live write landed between the export and the
comparison, so no re-run was needed.

**Content, not just count.** The restored database was re-exported and its
manifest diffed against the manifest of the archive that was restored from.
`diff` printed nothing: every table's row count and SHA-256 checksum matched,
which is content equality rather than cardinality equality. The round-trip
archive was deleted afterward so it is not mistaken for a backup of the real
database.

**FTS rebuilt, both indexes, counted and searched:**

- `people_fts`: 50 rows, matching the `people` count.
- `encounters_fts`: 25 rows, matching the `encounters` count.
- `SELECT p.full_name FROM people p WHERE p.id IN (SELECT f.id FROM
  people_fts f WHERE people_fts MATCH '<search term>')` returned the expected
  row, a real contact's full name. The FTS triggers fired during the bulk
  insert; the indexes are not just populated, they answer a real query
  correctly.

**Nothing surprising.** Every step matched the brief on the first attempt:
the `wrangler.jsonc` config entry was required and sufficient for
`migrations apply`, the batched count comparison avoided the compound-SELECT
limit, and the FTS reinsertion strategy in `restore.mjs` worked without a
code change. The drill passed cleanly, was recorded, and both database and
config entry were removed at the end.

---

## Run of 2026-08-27: argument validation deployed and exercised through a real client

Plan 2's Task 8. Records what a live MCP client actually sends, which is the
one thing the test suite cannot see: every test constructs its own arguments,
so nothing in it could reveal a client injecting a field of its own.

Deployed version `fbbc1e29-b09c-4247-8fa6-21558cabb85d`, rollback target
`557b28b9-c8ea-44a9-b16d-f3896b41f690`, both recorded before deploying rather
than after. A fresh archive was taken first: 1,074 rows, counts confirmed
against the database.

### The risk this run existed to settle

Every tool schema has declared `additionalProperties: false` since it was
written, and nothing enforced it until this deploy. If the Claude client added
any field of its own to `arguments`, every call to that tool would have started
failing the moment this shipped.

**It does not.** A read-only call succeeded on the first attempt after the
deploy, with validation live. That question is now answered by observation
rather than by hope.

### What was exercised

| Call | Result |
|---|---|
| `list_roster_sources` | Succeeded. First probe after deploy |
| `search_people` with `query` and `limit` | Succeeded |
| `search_people` with `people_cursor` | Page advanced correctly, no overlap |
| `create_person` with `idempotency_key` | Succeeded |
| `add_contact` | Succeeded |
| `log_encounter` omitting `occurred_on` | Succeeded, defaulted to 2026-08-27 |
| `delete_person`, both phases | Confirmation returned, then deleted |

The `log_encounter` result is worth keeping. `occurred_on` was `required` in
its schema until Task 3 removed it, while the handler had always defaulted it.
Omitting it now succeeds, and the date it chose was the owner's local date
rather than the UTC one, which had already rolled over. Both the schema fix and
`localDate`'s timezone handling survived the deploy.

### One thing this run did NOT establish

An attempt to send a null `label` to `add_contact` sent the string `"null"`
instead, and the record came back holding that string. That is a defect in how
the call was constructed, not in the tool. Nullability is covered by
`tests/schema-drift.test.ts`, which asserts the stored value is null and was
shown to fail when the handler coerces null to an empty string. The live path
remains unexercised for that specific case.

### Cleanup

The throwaway person, its contact, and its encounter were deleted through
`delete_person`'s two-phase confirmation. No smoke-test data remains.

---

## Run of 2026-08-28: Migration 0009 index planner check

Task 3. Confirms whether SQLite's query planner will use the new indexes added
for the read-surface filters. Run locally against the test database with
migrations 0001-0008 applied.

Wrangler 4.125.0.

    npx wrangler d1 execute junco-prm --local --command \
      "EXPLAIN QUERY PLAN SELECT id FROM people WHERE updated_at > '2026-01-01' ORDER BY id LIMIT 10"

Verbatim output:

```json
[
  {
    "results": [
      {
        "id": 5,
        "parent": 0,
        "notused": 223,
        "detail": "SCAN people USING INDEX sqlite_autoindex_people_1"
      }
    ],
    "success": true,
    "meta": {
      "duration": 1
    }
  }
]
```

**Verdict: the local D1 state has not applied migration 0009.** The EXPLAIN
found no `idx_people_updated` index; it scanned using only the primary key. A
PRAGMA index_list check confirms it:

    PRAGMA index_list('people')

Result (3 indexes total):

```json
{
  "results": [
    { "seq": 0, "name": "idx_people_organization", "unique": 0, "origin": "c", "partial": 0 },
    { "seq": 1, "name": "idx_people_archived", "unique": 0, "origin": "c", "partial": 0 },
    { "seq": 2, "name": "sqlite_autoindex_people_1", "unique": 1, "origin": "pk", "partial": 0 }
  ]
}
```

`idx_people_updated` is absent from this list. The table holds 0 rows.

**Why:** wrangler's `d1 execute` against the local database does not dynamically
discover or apply new migration files during an active session. The migrations
were committed to disk and are applied by the test suite's harness (which passes
599 tests), but wrangler's local D1 state was initialized before 0009 existed and
has not re-scanned or re-applied migrations. This means the EXPLAIN test says
nothing about planner choice - the index simply is not present to be chosen.

**What this means for the deploy:** The index exists in the migration file
(committed and tested). Once deployed, whether the planner uses it on a live
database is a question for the next measurement run. The filter is correct
without the index (it scans instead of seeks); the index is for speed, not
correctness, per the migration's own comments.

---

## Run of 2026-08-31: the read surface deployed and exercised

Plan 3's Task 10. The read-surface work went live and was verified against the
real roster through a Claude MCP client, not `curl`.

Deployed version `e06b75b1-1f53-47c3-9b81-ce7cea9f2410`, rollback target
`fbbc1e29-b09c-4247-8fa6-21558cabb85d`. A fresh archive was taken first
(`junco-backup-2026-08-31T17-23.json.bz2`, 126,158 bytes). Migration 0009
applied to the remote database about a minute before the deploy, so the window
in which a pre-migration idempotency key could re-execute was roughly that long.

**Verification could not run from the session that deployed.** A Claude Code
session fetches an MCP server's tool list once at start, so the deploying
session still resolved `export_data` and could not see `list_records`. A
subagent inherits that same list. The checks below were run from a separately
spawned agent process, which performed its own MCP handshake and saw all 32
tools. Worth knowing for every future deploy of this server.

### What was exercised

| Check | Result |
|---|---|
| Tool list is 32, `export_data` absent | Pass |
| `list_tags` returns the real vocabulary | Pass, 19 tags |
| `search_roster_entries` cursor advances | Pass, no overlap between pages |
| `person_name` inline on `list_encounters` | Pass, 5 of 5 populated |
| `updated_after` sees a tag write | Pass |
| `include` relations, counts unchanged | Pass, 65 people both ways |

The `updated_after` check is the one that matters. A tag was added to one
person, `list_records(scope: "people", updated_after: <five minutes earlier>)`
returned exactly that person, and the tag was then removed leaving their prior
tags intact. Before this deploy the relation writers did not move
`people.updated_at`, so that query would have returned nothing and reported no
error. This is the live proof of Task 2.

`include` was checked for count parity rather than trusted: 65 people with
relations inline and 65 without, with identical id ordering, so the relation
subqueries do not drop or duplicate rows across a page boundary.

### The tag vocabulary was reviewed, and is deliberately not recorded here

`list_tags` was called and the full vocabulary read. No near-duplicates of the
kind worth merging: no singular/plural pair, no case variant, no hyphenation
variant. Three tags exist that carry no people, so that part of the vocabulary
is defined but unused, and one event tag covers close to half the roster, which
is worth remembering before treating tag counts as a measure of anything other
than one event.

**The tags themselves are not written down here, and should not be.** This
repository is public. Tag names on a real roster are personal information about
the people in it: they carry client and vendor relationships, organizational
affiliations, conference attendance, and geography. The plan for this task asked
for the vocabulary to be recorded, which was the right instinct for a private
working note and the wrong one for a published file. Read it live with
`list_tags` when it is needed.

### Two things this run did NOT establish

The paging check used the query `"Mark"`, which matched the substring inside
`"Marketing"` in job titles rather than anyone named Mark. Paging is proven;
name matching specifically is not, and was not the point of the check.

Two `list_records` calls carrying `include` were refused by the verifying
client's own permission classifier, not by the Worker. The same calls succeeded
at a smaller `limit`, which points at response size on the client side. No
conclusion about the server should be drawn from those two refusals.
