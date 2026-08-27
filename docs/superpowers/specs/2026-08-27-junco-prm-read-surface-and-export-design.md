# Junco PRM - Backup, Validation, Read Surface, and Export

Date: 2026-08-27
Status: revised after a four-agent review
Supersedes nothing. Extends `2026-08-20-junco-prm-design.md`.

## Summary

Junco PRM has been deployed and in daily use since 2026-08-26. This spec covers the first body of work driven by that use rather than by design review. It builds the backup the project has never had, adds runtime validation of tool arguments, corrects three tool descriptions that misdescribe real behaviour, extends the read surface so routine questions cost one call rather than dozens, and adds the ability to edit a follow-up.

The tool surface grows from 28 to 32. One migration is required, and it adds indexes only.

## What the first revision changed, and why

The first draft was reviewed on 2026-08-27 by four agents. This section records what they overturned, because two of the corrections invalidate advice that had already been acted on.

**The original P0 could not run.** It prescribed `wrangler d1 export --remote` as the recovery path. That command does not support databases containing virtual tables, and migrations 0004 and 0006 create FTS5 virtual tables. **The parent design spec already says this**, at its line 472, with the Cloudflare citation at line 554, and specifies the correct backup design in the same section. The first draft read the neighbouring paragraph, quoted its reasoning about R2, and missed this one. Three of four reviewers caught it independently.

**The original P0 spike was unnecessary and was a live write.** It proposed creating and deleting a throwaway person on the production instance to learn whether `add_contact` deduplicates. The answer is in `src/tools/attributes.ts:45`: `ON CONFLICT (person_id, contact_type, normalized_value) DO NOTHING`. It no-ops, on the normalized value. Deleted.

**`updated_after` as originally specified would have silently missed every relation change.** No writer in `src/tools/attributes.ts` touches `people.updated_at`. The motivating use case for `include` was confirming a tagging pass ran; under the original spec that check would have returned empty and reported that nothing changed. Two reviewers found this independently.

**`include` as originally specified would have broken pagination.** "Joined and returned inline" against one-to-many tables makes row count stop meaning person count, so pages shrink silently and the keyset lands on the wrong record.

**The `cursor` alias is not being built, and neither is the two-cursor scheme it was patching.** `search_people` is split instead. See "The search split".

**Two open questions were answerable from the repository** and are answered rather than carried.

## Origin

Every item here comes from one of five notes written while using Junco against real data, plus findings made while reading the code.

**This section is the index. Nothing below requires reading the source notes.** Each request is restated in a form that can be judged on its own, and every later reference repeats its substance rather than only its number.

### Where every request lands

Numbers 1 to 9 are the author's own numbering and are preserved. Unnumbered items are given a letter.

| Ref | What it asks for | Lands in |
|---|---|---|
| 1 | Optional `include` for tags, links, and contacts on the record listing tool | P4 |
| 2 | An `updated_after` filter, so "what changed" does not mean pulling everything | P4 |
| 3 | Batch writes for encounters, links, and contacts | Deferred |
| 4 | `merge_people`, because nothing can remedy two records for one human | Deferred |
| 5 | Multi-person encounters, one record with several attendees | Deferred |
| 6 | Exact tag filtering, and a `list_tags` call returning the vocabulary | P4 |
| 7 | Structured roster filtering by role and promotion state, with no text query | P4 |
| A | `get_summary`, counts by scope in one call | Deferred |
| 8 | Edit an existing follow-up's note and due date | P5 |
| 9 | Reported as: roster search pagination returns the same page forever | P3, reframed |
| R | Rename `export_data`, whose name and description contradict each other | P4 |
| K | Return `external_row_key`, so a roster row can be matched to its entry | P4 |
| D1 | Document that `promote_roster_entry` stores the roster email as a contact | P2 |
| D2 | Document the `k:` / `e:` / `h:` discriminator on `external_row_key` | P2 |
| D3 | Document that `import_roster` returns counts rather than entry ids | P2 |

Items found by reading the code rather than filed by anyone:

| Ref | What was found | Lands in |
|---|---|---|
| C1 | No backup exists, and none ever has | P0, P1 |
| C2 | Tool arguments are never validated, on any tool | P3 |
| C3 | Relation writes never bump `people.updated_at`, so deltas would be lossy | P4 |

## Goals

- Junco's data survives the loss of the Cloudflare account, and the restore has been performed rather than described.
- A caller that misnames an argument is refused rather than silently given a wrong answer.
- "What is in here, and what changed" costs one call rather than one per record.
- Tool descriptions match tool behaviour.
- A follow-up can be corrected without falsifying its history.

## Non-goals

- No batch writes, no `merge_people`, no multi-person encounters. All deferred, with reasons below.
- No CSV. JSON round-trips; CSV is a later convenience if it is ever wanted.
- No change to authentication, authorization, or the OAuth flows. **Changed from the first draft**, which proposed a loopback-OAuth CLI. The backup now uses `wrangler`, which the operator already has authenticated.
- No tombstones for deleted records.

## Constraints

**The instance is live and holds real data.** As of 2026-08-27 it holds 798 roster entries with 0 stale, 39 promoted, plus the durable records built from them. Every change here lands on that database.

**Migrations and Worker deploys are not atomic.** Every schema change here is additive and index-only, so either order is safe: new code without the index is correct but slower, the index without new code is inert.

**FTS5 tables are virtual tables**, created in migrations 0004 and 0006. Any backup must name its tables explicitly rather than dumping the database, and must treat the FTS indexes as derived data rebuilt from the source tables on restore.

**D1 binds at most 100 parameters per statement.** `docs/MEASUREMENTS.md` records this as still binding, and `KEY_LOOKUP_CHUNK` is already 99 because of it. Any design that binds a page of ids collides with this.

**Free plan limits still apply**, and nothing here detects or degrades at D1's 500 MB ceiling. Recorded in the project's known gaps and not closed.

## Phasing, and why this order

| Phase | Contents | Schema | Risk |
|---|---|---|---|
| P0 | Time Travel verified and documented | none | none, no code |
| P1 | Backup script, and a restore actually performed | none | reads only |
| P2 | Three tool description fixes | none | none |
| P3 | Argument validation across all tools | none | changes refusal behaviour |
| P4 | Read surface, including the search split | one migration, indexes | additive, one breaking split |
| P5 | `update_followup` | none | additive |

**P0 and P1 are first because the exposure is real and current.** Everything after them modifies a live database that has no backup.

**P3 comes before P4 deliberately.** P4 adds four tools and several parameters, and adding them to a surface that silently swallows unrecognized arguments multiplies the failure mode. Unanimous across all four reviewers.

**The archive that was a separate phase in the first draft is gone.** Its purpose is served by P1, which produces a real backup rather than a projection of one. What remains of the idea is under "Deferred, and why".

## P0 - Time Travel, verified and documented

No code. This is what protects the data today, and it needs no artifact at all.

D1 Time Travel provides point-in-time restore, retained 7 days on the free plan and 30 on paid, on by default with no setup. `wrangler d1 time-travel info` and `wrangler d1 time-travel restore` both exist in wrangler 4.125.0, verified 2026-08-27.

It covers the likely event: a migration or a code change wrecked something on Tuesday. It does not cover account loss, database deletion, or corruption older than the retention window. That is P1, and the runbook states the division plainly so nobody reaches for the wrong one during an incident.

1. Run `wrangler d1 time-travel info` against the live database and record what it reports, including whether the database is on a backend that supports it.
2. Document taking a bookmark before every migration and every deploy, and where the operator records it.
3. Document the restore command, and plainly that restore is destructive and in place.

**The runbook lives in `docs/` in the repository, not in a personal checklist.** A recovery procedure that exists only on one laptop is one lost laptop from not existing.

## P1 - The backup, and a restore that has actually happened

The phase this project has been missing since its first record was written.

### Mechanism

A local script the operator runs, using `wrangler d1 execute --remote --json --command`, verified present in wrangler 4.125.0 on 2026-08-27. One statement per durable table, output captured as JSON.

**Naming the tables explicitly is what makes this work at all.** `wrangler d1 export` is refused by databases containing virtual tables. Selecting from named tables never touches the FTS5 tables, so the constraint that defeats the dump does not apply.

The FTS indexes are not backed up. They are derived data, rebuilt on restore by reinserting rows into the source tables so the existing triggers fire. With standalone FTS tables that means reinsertion, not a `rebuild` command, which only external-content tables understand.

### What the archive contains

The parent design already specifies the shape, and it is adopted rather than reinvented: a manifest carrying schema version, application version, export timestamp, and per-table row counts and checksums; tables written in dependency order; the file created atomically with restrictive permissions.

**The table inventory is enumerated explicitly in the plan.** It must include the durable tables, the staged roster tables, and provenance, specifically `person_sources.raw_record_snapshot` and `roster_entries.raw_record`, neither of which any read tool returns. The snapshot is the one thing that survives a roster purge, which makes it among the highest-value content in the archive.

A caveat the parent design records and which stands: a table-by-table export does not block other requests, so a write landing mid-export can leave two tables describing different moments. For a single-user PRM whose operator runs the export themselves that is acceptable, and it is written down rather than glossed.

Compression is `bzip2`; verification is `bzip2 -t` plus a row-count comparison against the live database. **The first draft's verification step was wrong** and is corrected: it looked for a `Dump completed` trailer, which is a `mysqldump` artifact `wrangler` does not produce. A count comparison is what actually detects a truncated file.

### The restore is part of this phase

**An export nobody has restored is not a backup.** The restore is performed here: import the archive into a disposable D1 database, rebuild the FTS indexes, and compare record counts and a content sample against the source. It is re-run whenever a migration changes the schema, because an export format that has not been restored since the last migration is untested again.

### Cadence

The runbook states how often the export runs and where the files go. With Time Travel at 7 days on the free plan, a cadence longer than weekly leaves a gap neither layer covers. Naming the cadence and saying plainly what is lost if nobody follows it is part of the deliverable.

## P2 - Documentation corrections

Three descriptions in `src/tools/index.ts`. No behaviour change, no schema, no migration.

**`promote_roster_entry` stores the roster row's email as a person contact.** Confirmed by promoting a person whose roster row carried an address and reading the result back; the control case, a roster row with no email, returned empty contacts. This matters because the neighbouring `create_person` documents the opposite contract, stating its `email` is "used only to check for duplicates; add_contact stores it".

It can also now state the consequence the first draft left to a spike: a redundant `add_contact` for an address the person already holds is a no-op, not a duplicate, because `attributes.ts:45` carries `ON CONFLICT (person_id, contact_type, normalized_value) DO NOTHING` against the `UNIQUE` constraint in migration 0001. The match is on the normalized value, so `Ada@Example.test` and `ada@example.test` are one contact.

**`person_sources.external_row_key` carries a discriminator, not a bare prefix.** `src/normalize.ts:130` builds the key as `k:` plus the source's own row id, falling back to `e:` plus the normalized email, falling back to `h:` plus a digest of name and organization.

Stability is per-tier and the description says so rather than claiming the key is stable: `k:` is exactly as stable as the source's own id, `e:` changes when the email changes, `h:` changes when the name or organization changes.

**`import_roster` returns counts, not entry ids.** The consequence is stated nowhere a caller reads before designing an import: afterward the caller holds source ids and Junco holds `re_` ids, with no supported call mapping one to the other.

That third sentence is deleted again in P4, when `external_row_key` becomes readable. Recorded so a later reader does not find a stale warning and trust it.

## P3 - Argument validation

### The defect

**Tool arguments are not validated against the declared input schema.** `src/mcp/server.ts:41` passes each tool's `inputSchema` straight through to the MCP SDK's low-level `Server`. The SDK validates arguments against a tool's schema only through the high-level `registerTool` with Zod shapes, which this server does not use. An unknown tool *name* is refused cleanly. An unknown *argument* reaches the handler and is ignored by property access.

The consequence is worse than a missing feature: a caller that misnames a parameter receives a confident, plausible, wrong answer and no error.

This was predicted. Plan 1 deferred runtime validation of the registry's input schemas to plan 2, and plan 2 did not implement it.

### Request 9, and why it is not what it says

**Request 9 as filed.** Searching the roster returns a `roster_next_cursor`. Passing that cursor back with the same query returns the identical rows and the identical cursor token, so the page never advances. Filed as a bug, priority medium. The reporter's reasoning: with 798 entries and a text match that also hits job titles, a search for a first name returns mostly irrelevant rows, so the real candidates sit past the cutoff and cannot be reached.

**Roster pagination is correct**, proven against the live instance on 2026-08-27. Passing the token back as `roster_cursor` advanced from the first three entries alphabetically to the next three, with no overlap and a fresh cursor, which is correct keyset behaviour. The names are omitted because this file is published and the roster holds real people; the run is recorded in full where it is not.

The reproduction passed `cursor`. `search_people` has no such parameter. The argument was unrecognized, dropped, and the query restarted, producing exactly the reported symptom.

**The claim is narrowed from the first draft.** Roster pagination was proven. `people_cursor` was not separately exercised, so no claim is made about it. Every reviewer flagged the original wording as overreaching.

### Design

Every tool's declared `inputSchema` becomes enforceable at call time. Unknown arguments, wrong types, and missing required arguments are refused with `invalid_input`, carrying a message naming what was rejected and what was expected, because the reader is a model deciding what to do next.

**The validator is chosen here rather than left to the plan.** Ajv's default runtime compiles schemas with `new Function`, which workerd forbids, so it would need standalone precompilation. The schema vocabulary actually in use is small: `type` including union types, `enum`, `pattern`, `items`, `required`, and `additionalProperties: false`. A hand-written walker over the existing `JsonSchema` type is the choice: no dependency, exactly the vocabulary present, and the error messages stay under this project's control, which the design says matters.

The plan states explicitly: no type coercion, no default injection, unknown properties rejected at the top level, `null` distinct from omission, and validation running before idempotency handling or any database work.

### The schema-versus-handler audit comes first

These schemas have never controlled runtime behaviour, so any drift between a declared schema and its handler becomes a production failure the moment validation is switched on. **The first task of this phase is a compatibility table covering all 28 tools.**

One case is already known and is resolved rather than discovered: `export_data` declares `required: ["scope"]` at `tools/index.ts:239`, while `exportData` defaults it with `input.scope ?? "people"` at `export.ts:79`. Under validation, a call with no scope starts failing. Which is right is decided in this phase and aligned deliberately, not changed by accident.

### The reproducing test

Written before the fix, and **it must call through the transport boundary**, meaning `buildServer`'s `CallToolRequestSchema` handler with a misnamed argument. A test that calls the tool function directly cannot see this defect, because the defect lives in the layer above it. That is exactly the shape of the seventeen tests this project has already shipped that passed and guarded nothing.

Its primary negative assertion is that an invalid write returns `invalid_input`, invokes the handler zero times, and creates zero database rows.

## P4 - Read surface

The organizing rule, chosen over extending one tool with structured filters: **search is for text, list is for filters.** A model selects the right tool from its name rather than from a combination of optional parameters.

### The search split

**`search_people` is split into `search_people` and `search_roster_entries`.** Each searches one record kind, returns one array, and pages with one plainly named `cursor`.

This replaces both the two-cursor scheme and the conditional `cursor` alias the first draft proposed. The alias would have made a tool's valid arguments depend on another argument's value; two reviewers rejected it outright and a third accepted it only with a rule matrix the draft did not have.

The argument for the split is the evidence already in hand: **a real model got the two-array shape wrong and filed the result as a pagination bug.** A tool returning two arrays and taking two differently-named cursors is harder to use correctly than two tools each returning one, and the failure mode is silent. Validation in P3 makes that mistake loud, which is worth doing regardless; the split means the mistake is not available to make.

`search_people` loses its `scope` parameter. The roster half becomes `search_roster_entries`, which sits beside `list_roster_entries` under the same rule: search is text, list is filters.

One reviewer argued for the conditional alias on the grounds that its cost is inert with one tool and one operator. That is true, and it is not the standard being applied. The surface is read by a model on every call, and the cheapest thing to get right is the shape it sees.

### Tool surface after this phase

| Tool | Change |
|---|---|
| `search_people` | People only. Loses `scope`. Pages with `cursor` |
| `search_roster_entries` | New. Text search over roster entries. Returns `external_row_key` |
| `get_roster_entry` | Gains `external_row_key` |
| `list_records` | Renamed from `export_data`. Gains `include`, `updated_after`, `tags`, `archived` |
| `list_roster_entries` | New. `source_key`, `role`, `promoted`, `organization` |
| `list_tags` | New |

28 tools become 32.

**Every new tool declares all three MCP annotations and a pagination contract**, per the parent design's rule that the first draft omitted. The three list tools and `search_roster_entries` are `READ`, each with a stated default and maximum page size and a `cursor` on the one convention.

### `include`

`include: ["tags", "links", "contacts"]` on `scope: "people"`. Refused on the other scopes rather than accepted and ignored, since person identity is already inline there and no other relations exist.

**The loading mechanism is specified, because the obvious implementation is wrong.** A literal join against one-to-many tables makes row count stop meaning person count: a person with three tags consumes three rows of the limit, the page returns fewer people than requested, and the keyset lands on the last row rather than the last person. Pages shrink silently.

Paging people first and binding their ids collides with D1's 100-parameter cap, which is why `KEY_LOOKUP_CHUNK` is 99. A hundred bound ids consumes the entire budget, leaving none for the other filters, and it fails at exactly the maximum a caller is most likely to request.

**The mechanism is one statement per relation, binding no id list**, repeating the page predicate as a subquery: `WHERE person_id IN (SELECT id FROM people WHERE <same filters> ORDER BY id LIMIT ?)`. Three extra statements, no id list, no interaction with the parameter cap. The keyset stays on the people query.

Returned shapes match what exists rather than inventing a second shape for the same thing: tags as `string[]`, contacts as `{id, contact_type, value, label}`, links as `{id, link_type, url}`.

### `updated_after`, and the propagation it requires

**No writer in `src/tools/attributes.ts` touches `people.updated_at`.** `addContact`, `addLink`, `addTags`, `removeContact`, `removeLink`, and `removeTags` all write child tables and return `getPerson`, and none issues an `UPDATE people`. Verified: zero matches for `UPDATE people` in that file. The only writers are `createPerson`, `updatePerson`, `archivePerson`, and promotion.

Without a change, `updated_after` misses every tag, link, and contact change. The failure is asymmetric and undetectable: `update_person` does bump the timestamp, so deltas appear to work, and the caller learns the filter is lossy only by noticing an absence. **This is precisely the check `include` exists to serve**: run a tagging pass Monday, ask what changed Tuesday, be told nothing did.

**All six attribute writers bump `people.updated_at`** in the same batch as the child write, making the timestamp mean "anything about this person changed", which is what a caller assumes. `addTags` already uses `db.batch`, so the shape exists.

The first draft asserted that `people.updated_at` being `NOT NULL` made the filter "total on that scope". True about nulls, false about totality, and the false half was the one a reader would have acted on.

Two further rules, both of which produce silent wrongness if left unstated:

**The input is canonicalized before comparison.** `updated_at` is TEXT compared lexicographically. `isIsoInstant` in `src/time.ts` makes milliseconds optional, so a caller passing `2026-08-27T12:00:00Z` compares `Z` against the `.` of a stored `2026-08-27T12:00:00.500Z`; the stored value sorts lower and vanishes from the delta. Every record updated in the same second as the watermark disappears. The input is normalized through `new Date(value).toISOString()` and anything `Date.parse` cannot read is refused.

**The comparison is exclusive**, which is correct for a watermark loop, and the description says so, because a model choosing between `>` and `>=` on a re-poll will otherwise duplicate or skip.

`updated_at` is added to the encounter and follow-up select lists, which currently omit it. `export.ts` and `encounters_read.ts` both select encounters through separate column lists and both must change. Adding `person_name` to the shared list changes the response shape of `log_encounter`, `update_encounter`, `delete_encounter`, `get_person`, and `list_encounters` at once, and means idempotency records stored before the change replay the old shape on retry. The plan states which is being done.

**Deletions are not reported.** A delete becomes invisible to a delta caller, who sees only that the record is gone from a full list. Stated in the description rather than left to be discovered.

### `tags` filter and `list_tags`

A `tags` filter on `list_records(scope: "people")`, AND semantics across multiple tags, refused on the other scopes.

**The filter normalizes its input** with `normalizeText`, as `remove_tags` already does. Tag names are stored lowercased through that function, so a literal match against `["Speaker"]` would return a well-formed empty page. A model echoing `list_tags` output would be fine; a model working from a human's phrasing would not.

`list_tags` returns each tag with a count of people carrying it, and doubles as hygiene: `speaker` against `speakers` becomes visible as soon as both exist.

Two behaviours are decided rather than left implicit. **Tags with a zero count are included**, because `removeTags` never deletes the `tags` row and `delete_person` cascades `person_tags` but not `tags`, so orphans accumulate, and the hygiene argument is exactly the argument for showing them. **Counts exclude archived people**, and the response says so, since `list_records` and `search_people` currently disagree about archived by default and a count that silently includes them is a wrong number.

### `archived` on `list_records`

`list_records(scope: "people")` currently returns archived people with no way to exclude them, while `search_people` excludes them by default. Two read tools with opposite defaults, one with no filter, is a wrong count waiting to happen. An `archived` filter is added and the default stated in the description.

### `list_roster_entries`

Optional `source_key`, `role`, `promoted`, and `organization`. No text query; that is `search_roster_entries`.

Roster entries carry a `role`, but text search requires a query, so there is no way to ask for all rows with a given role or to page the roster without inventing search terms. The blocked task is "promote all speakers", which currently requires knowing their names first. The `promoted` boolean is the working queue: everything not yet promoted is currently unaskable.

**Contract stated in full**, because `promoted: false` over the WCUS source returns 759 rows on the first call: result shape, default and maximum limit, ordering with an id tiebreaker, `cursor` on the standard convention, whether stale rows are included, and case handling for `role` and `organization`, which are stored as imported rather than normalized. It returns `external_row_key` for the same reason search does.

**`promoted` is derived, not stored.** It is a correlated lookup into `person_sources` on `(source_key, external_row_key)`. There is no column on `roster_entries` to index, and the lookup side is already covered by the `UNIQUE (source_key, external_row_key)` in migration 0002. So the filter scans the source's rows. At 798 that is fine, and the spec says so rather than promising an index that cannot exist.

### `external_row_key`

Returned by `search_roster_entries`, `list_roster_entries`, and `get_roster_entry`.

`import_roster` treats it as row identity, but nothing in the read surface returns it, so a promotion pipeline cannot connect a source row to the entry it created. The WCUS migration matched on `full_name`, which worked only because all 35 promoted names happened to be unique among 798 rows. That roster contains eleven duplicated names.

**Returning it puts email addresses into results that currently exclude them, and that is a decision rather than a side effect.** Tier 2 is `e:` plus the normalized email. `src/tools/search.ts` deliberately excludes `raw_record` from roster hits because the result "goes straight into a model's context, often immediately before a write against one of these records", and `src/normalize.ts` already carries a comment noting the key column holds a live email in tier 2. For the WCUS roster this means third-party addresses flowing into context on every roster read.

The field is returned as-is, because an opaque digest defeats the join-back use case that is the entire point. The tool description and this spec say what the field can contain.

**Option 1 only.** `promote_roster_entry` does not gain the ability to accept `source_key` plus `external_row_key` in place of a `roster_entry_id`.

### Migration 0009

Indexes only. Two of the first draft's four open questions are answered from the repository, which shrinks this considerably:

- **`person_tags(tag_id, person_id)` is needed.** The table has `PRIMARY KEY (person_id, tag_id)` and no other index, verified in migration 0001, so the tag-to-person direction is unindexed.
- **`roster_entries(roster_source_id, role)`** if the role filter is to be indexed. The table already has indexes on `roster_source_id`, `last_seen_run_id`, `full_name`, and `email`, and nothing on `role`.
- **`people(updated_at)`, `encounters(updated_at)`, `followups(updated_at)`** for `updated_after`.
- **Nothing for `promoted`**, for the reason above.

Each index is tied to the exact statement it serves, and the plan checks the query plan rather than assuming the planner uses it.

## P5 - `update_followup`

`update_followup(followup_id, note?, due_on?)`, updating whichever fields are supplied.

Follow-ups can be created, completed, and cancelled, but not changed. Neither workaround is correct. Cancelling and recreating writes `cancelled_at` on a follow-up that was never abandoned, so the history lies and no future reader can distinguish a real cancellation from a bookkeeping one. Creating a second follow-up puts two open items on one person for one obligation, inflating the single number `list_due` exists to report. Due dates have the same problem: four follow-ups currently share one date because it was chosen when the first was created.

**Editing a completed or cancelled follow-up is refused**, which keeps the closed record honest.

Details the first draft omitted:

- **The annotation is `DESTRUCTIVE`**, by the same reasoning the code already applies to `update_person` and `update_encounter`: it overwrites a note the user wrote and nothing retains the previous text.
- **It takes an `idempotency_key`**, like every other write in this project.
- **At least one of `note` or `due_on` is required.** A call supplying neither is refused rather than silently succeeding.
- **Whether `null` clears a note** is decided explicitly, not left to the handler's truthiness.
- **The write is conditional**, requiring both `completed_at` and `cancelled_at` to still be null in the same statement. A read-then-update sequence can race with a completion and edit a closed record.

No schema change: `followups` already carries `note`, `due_on`, and `updated_at`.

## Testing

This project's record sets the standard. Seventeen tests across plans 1 and 2 passed, were named for the right thing, and guarded nothing. Not one was caught by the suite going red. A frozen test clock separately hid three live bugs.

**Every new test states what it fails on**, in its name or a comment.

**A green suite proves nothing until the mutation is confirmed to be a real behaviour change.** An earlier finding here was withdrawn for exactly this reason: an index supplied the ordering a removed sort tiebreak had been credited with, so the mutation changed nothing and the suite was right to stay green.

**`updated_after` gets a mutable clock**, deliberately. It is the clock-dependent feature here and a frozen instant is what hid three defects before.

**Pagination is tested with more rows than the page limit, through the transport**, not by handing a cursor back to a handler.

Specific guards: a registry test asserting `export_data` is absent; the P3 reproducer above; a test proving `include` returns exactly the requested number of distinct people when every person carries several relations of each kind; and a test proving a relation write moves `people.updated_at`.

## Per-phase live verification

This project's worst defect was found by running code rather than reading it, and two browser-only defects survived 472 passing tests. Each phase therefore ends with the same three steps rather than with a green suite:

1. Deploy.
2. Exercise the affected tools through the real connector, against the live instance.
3. Record the result in `docs/MEASUREMENTS.md`, beside the platform facts, including anything surprising.

**Rollback is named for every phase:** `wrangler rollback`, or `wrangler versions deploy` to the prior version. One line, so that a tool refusing at eleven at night produces a command rather than a debugging session.

**P3's deploy gets a full smoke pass**, calling every tool through the real connector with the arguments actually in use. Reads freely, writes against a throwaway person. This is the only way to discover one class of drift: what the Claude client itself puts in `arguments`. The schemas declare `additionalProperties: false` and nothing enforces it today, so if any client injects a field, that deploy is when it surfaces. Unfalsifiable by reading, trivial by running.

The migration in P4 is applied before the deploy that uses it, stated here so it is not decided at the keyboard.

## Deferred, and why

**Batch writes (request 3), which asks that `log_encounter`, `add_link`, and `add_contact` each accept an array as well as a single record, returning per-item results so a partial failure is legible.** The case for it: a conference debrief produced eleven separate `log_encounter` calls, and one person alone carried five links. It changes the input shape of three shipped tools rather than adding to them, and raises questions this spec does not need to answer: all-or-nothing versus partial success, and how one idempotency key covers many items.

**`merge_people` (request 4), which asks for a preview-then-confirm merge moving encounters, follow-ups, contacts, links, tags, and provenance from one person record onto another.** The case for it: promotion previews duplicates and so prevents them at promotion time, but once two person records exist the only remedy is `delete_person`, which is permanent and discards whatever the losing record carried. It needs a tombstone or a `merged_into` column so a merged id stays resolvable, which is the first durable schema change in this body of work.

**Multi-person encounters (request 5), which asks that one encounter record carry several attendees rather than being split into one record per person.** The case for it: two people met together produce two encounters with overlapping summaries, so the story is complete in neither and editing it later means editing it twice. `encounters.person_id` is `NOT NULL` with a direct foreign key, verified in migration 0005. Supporting several attendees means a join table and rebuilding `encounters` on a live D1 holding real records. The highest-risk change in the whole set.

**`get_summary` (ref A), which asks for counts by scope, the most recent encounter date, and the open follow-up count in a single call.** The case for it: reporting "42 people, 11 encounters, 2 open follow-ups" required pulling every full record across three calls and still missed tags and links. The request itself observes that `include` and `updated_after` landing may remove the need.

**A JSON archive served over MCP, which the first draft proposed as its own phase.** P1 produces a real backup with a performed restore, which is what the archive was reaching for. A projection served through tool calls would additionally have been unable to reach `person_sources.raw_record_snapshot`, `roster_entries.raw_record`, roster sources, or import runs, none of which any tool returns, so it would have promised more than it could contain. If a portable projection is still wanted later it is a small script over the P1 archive, not a Worker route.

## Open questions

- Whether the live database is on a D1 backend that supports Time Travel, settled by the first command in P0.
- Whether `export_data`'s declared `required: ["scope"]` or its handler's default is correct, settled during P3's audit.
- The exact `wrangler d1 execute` invocation and output shape per table, settled when the P1 script is written. The command and its `--remote`, `--json`, and `--command` flags are verified present in wrangler 4.125.0; the shape of large result sets is not.
- Whether adding `person_name` to the shared encounter column list, and so changing five tools' response shapes at once, is preferable to a separate list for `list_records`.

## Verification notes, 2026-08-27

Recorded because these were checked rather than recalled.

- Roster pagination advances correctly, proven against the live instance with two pages at `limit: 3`.
- The live instance holds 798 roster entries, 0 stale, 39 promoted, last imported `2026-08-27T04:55:22.523Z`.
- `wrangler d1 execute` supports `--remote`, `--json`, and `--command`; `wrangler d1 time-travel info` and `restore` exist. Checked against wrangler 4.125.0.
- `wrangler d1 export` does not support databases containing virtual tables. Recorded in the parent design spec at lines 472 and 554 with the Cloudflare citation, and confirmed independently by three reviewers.
- `src/mcp/server.ts:41` passes `inputSchema` through to the low-level `Server`. No argument validation exists in `src/mcp/transport.ts` or `src/mcp/server.ts`.
- `src/tools/search.ts:201` reads `input.scope ?? "people"`, so scope defaults to people rather than to all. One reviewer's argument against the cursor alias rested on the opposite and was set aside.
- `src/tools/attributes.ts` contains no `UPDATE people` statement. None of the six relation writers bumps `people.updated_at`.
- `src/tools/attributes.ts:45` carries `ON CONFLICT (person_id, contact_type, normalized_value) DO NOTHING`, so `add_contact` no-ops on a duplicate normalized value.
- `person_tags` has `PRIMARY KEY (person_id, tag_id)` and no other index, verified in migration 0001.
- `export_data` declares `required: ["scope"]` at `tools/index.ts:239`; `export.ts:79` reads `input.scope ?? "people"`.
- `src/normalize.ts:130` builds `external_row_key` with the `k:` / `e:` / `h:` discriminator.
- `people.updated_at` is `NOT NULL` (migration 0001). `encounters.person_id` is `NOT NULL` with a foreign key (migration 0005).
- The suite is 475 tests across 37 files, all passing, with a clean typecheck.
