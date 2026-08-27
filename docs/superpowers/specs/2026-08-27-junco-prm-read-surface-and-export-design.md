# Junco PRM - Read Surface, Validation, and Export

Date: 2026-08-27
Status: draft, awaiting review
Supersedes nothing. Extends `2026-08-20-junco-prm-design.md`.

## Summary

Junco PRM has been deployed and in daily use since 2026-08-26. This spec covers the first body of work driven by that use rather than by design review. It closes a backup exposure that has existed since the first record was written, corrects three tool descriptions that misdescribe real behaviour, adds runtime validation of tool arguments, extends the read surface so a caller can answer routine questions in one call instead of dozens, adds the ability to edit a follow-up, and builds a portable archival export.

The tool surface grows from 28 to 31. One migration is required, and it adds indexes only.

## Origin

Every item here comes from one of five notes written while using Junco against real data, plus two findings made while reading the code to plan this work. Nothing in this spec was invented from the tool list.

**This section is the index. Nothing below requires reading the source notes.** Each request is restated here in full enough form to be judged on its own, and every reference later in the document repeats its substance rather than only its number.

### Where every request lands

Fifteen distinct asks. Numbers 1 to 9 are the author's own numbering and are preserved. Unnumbered items are given a letter here so they can be referred to.

| Ref | What it asks for | Lands in |
|---|---|---|
| 1 | Optional `include` for tags, links, and contacts on the record listing tool | P3 |
| 2 | An `updated_after` filter, so "what changed" does not mean pulling everything | P3 |
| 3 | Batch writes for encounters, links, and contacts | Deferred |
| 4 | `merge_people`, because nothing can remedy two records for one human | Deferred |
| 5 | Multi-person encounters, one record with several attendees | Deferred |
| 6 | Exact tag filtering, and a `list_tags` call returning the vocabulary | P3 |
| 7 | Structured roster filtering by role and promotion state, with no text query | P3 |
| A | `get_summary`, counts by scope in one call | Deferred |
| 8 | Edit an existing follow-up's note and due date | P4 |
| 9 | Reported as: roster search pagination returns the same page forever | P2, reframed |
| R | Rename `export_data`, whose name and description contradict each other | P3 |
| K | Return `external_row_key`, so a roster row can be matched to its entry | P3 |
| D1 | Document that `promote_roster_entry` stores the roster email as a contact | P1 |
| D2 | Document the `k:` / `e:` / `h:` discriminator on `external_row_key` | P1 |
| D3 | Document that `import_roster` returns counts rather than entry ids | P1 |

Two further items came from reading the code rather than from a note, and neither was filed by anyone:

| Ref | What was found | Lands in |
|---|---|---|
| C1 | No backup exists, and none ever has | P0 |
| C2 | Tool arguments are never validated, on any tool | P2 |

## Goals

- Junco's data can be recovered if the Cloudflare account is lost, and can be read without Junco.
- A caller that misnames an argument is refused rather than silently given a wrong answer.
- The routine question "what is in here, and what changed" costs one call rather than one call per record.
- Tool descriptions match tool behaviour.
- A follow-up can be corrected without falsifying its history.

## Non-goals

- No restore tooling. A tested restore remains plan 3 work. This spec produces two ways to get data out and no automated way to put it back.
- No batch writes, no `merge_people`, no multi-person encounters. All three are deferred, with reasons under "Deferred, and why".
- No CSV. The archival export emits JSON, which round-trips. CSV is a later convenience if it is ever wanted.
- No change to authentication, authorization, or the OAuth flows.

## Constraints

**The instance is live and holds real data.** As of 2026-08-27 it holds 798 roster entries with 0 stale, 39 of them promoted, plus the durable records built from them. Every migration in this spec is applied to that database. This is the constraint that shaped the phasing.

**Migrations and Worker deploys are not atomic.** A migration and the code that uses it reach production as two separate operations. Every schema change in this spec is therefore additive and index-only, so either deploy order is safe: new code without the index is correct but slower, and the index without new code is inert.

**Free plan limits still apply**, and nothing in this spec detects or degrades gracefully at D1's 500 MB ceiling. That gap is recorded in the project's known gaps and is not closed here.

## Phasing, and why this order

| Phase | Contents | Schema | Risk |
|---|---|---|---|
| P0 | Backup runbook, `add_contact` dedup spike | none | none, no code |
| P1 | Three tool description fixes | none | none |
| P2 | Argument validation across all tools | none | changes refusal behaviour |
| P3 | Read surface | one migration, indexes | additive |
| P4 | `update_followup` | none | additive |
| P5 | JSON archival export CLI | none | additive |

**P0 is first because the exposure is live.** Real data has existed with no copy since 2026-08-26.

**P2 comes before P3 deliberately.** P3 adds five tools and several parameters. Adding them to a surface that silently swallows unrecognized arguments multiplies the failure mode rather than containing it. Validation first means every parameter P3 introduces is enforced from the moment it exists.

**P1 comes before P2** only because it is free and unblocks nothing. It could move without consequence.

## P0 - Close the backup exposure and settle one unknown

No feature code. Both items are run by the operator.

### The wrangler backup runbook

**There is no backup and there never has been.** Verified on 2026-08-27: `package.json` contains exactly two scripts, `test` and `typecheck`. No export CLI exists in the repository. The only matches for "backup" are git tags. Meanwhile `src/tools/index.ts` tells the model that `export_data` "is not the backup", pointing at something that was designed in the original spec, assigned to plan 3, and never built.

The original spec's reasoning stands and is not revisited: backup is a local export the operator runs, not a Worker cron writing to R2, because a copy that lives inside the account is not a backup of that account.

What is added now is a documented runbook step using Cloudflare's own tooling, which needs no code:

1. Export the remote database to a file with `wrangler d1 export --remote`.
2. Compress with `bzip2`, named `.sql.bz2`.
3. Verify with `bzip2 -t`, and confirm the dump reached its end rather than trusting the exit status, because a dump piped into a compressor can fail while the pipeline still exits 0.

The exact flag set is confirmed when the runbook is written rather than asserted here. The runbook lives in the operator checklist, not in the repository, until plan 3 gives it a home.

This is the recovery path. The P5 export is not.

### The `add_contact` dedup spike

**Unknown:** what `add_contact` does when handed an address a person already holds. It may refuse, store a duplicate, or no-op.

This was never established because the WCUS migration skipped 19 redundant calls rather than making them. It matters because it decides whether the `promote_roster_entry` behaviour documented in P1 is a documentation problem alone or also a data-integrity one.

Method: create a throwaway person on the live instance, hand it an address it already holds, observe, then delete it. The result is recorded in `docs/MEASUREMENTS.md` alongside the platform facts the earlier spike settled, and it determines P1's wording.

## P1 - Documentation corrections

Three descriptions in `src/tools/index.ts`. No behaviour change, no schema, no migration. Each is a real behaviour that a caller cannot discover before relying on it.

**`promote_roster_entry` stores the roster row's email as a person contact.** Confirmed by promoting a person whose roster row carried an address and reading the result back: the person already held it as a `person_contact`, with no `add_contact` call made. The control case, a roster row with no email, returned empty contacts. This matters because the neighbouring `create_person` documents the opposite contract, stating its `email` is "used only to check for duplicates; add_contact stores it". The description must state the behaviour and state plainly that it differs from `create_person`.

**`person_sources.external_row_key` carries a discriminator, not a bare prefix.** `src/normalize.ts:130` builds the key as `k:` plus the source's own row id, falling back to `e:` plus the normalized email, falling back to `h:` plus a digest of name and organization. A caller comparing a returned key against the id it sent finds no match, silently. The description must document the three-way scheme and say whether it is stable, because anyone joining provenance records back to their own source data will do a string comparison and get it wrong once.

**`import_roster` returns counts, not entry ids.** The consequence is not stated anywhere a caller reads before designing an import: after the import, the caller holds source ids and Junco holds `re_` ids, with no supported call mapping one to the other. A caller discovers this after the data is imported, which is the worst moment.

That third sentence is deleted again in P3, when `external_row_key` becomes readable. The spec records this so a later reader does not find a stale warning and trust it.

## P2 - Argument validation

### The defect

**Tool arguments are not validated against the declared input schema.** `src/mcp/server.ts:41` passes each tool's `inputSchema` straight through to the MCP SDK's low-level `Server`, with a comment noting that passing it through is the whole reason for using the low-level API. The SDK validates arguments against a tool's schema only through the high-level `registerTool` with Zod shapes, which this server does not use. An unknown tool *name* is refused cleanly. An unknown *argument* is dropped in silence.

The consequence is worse than a missing feature. A caller that misnames a parameter receives a confident, plausible, wrong answer and no error.

This was predicted. Plan 1 deferred runtime validation of the registry's input schemas to plan 2, and plan 2 did not implement it.

### Request 9, and why it is not what it says

**Request 9 as filed.** Searching the roster returns a `roster_next_cursor`. Passing that cursor back with the same query returns the identical rows and the identical cursor token, so the page never advances. Filed as a bug rather than a feature, priority medium. The reporter's reasoning: with 798 entries and a text match that also hits job titles, a search for a first name returns mostly irrelevant rows, so the real candidates sit past the cutoff and cannot be reached. The first screen of any roster search is the only screen.

**Pagination is correct**, proven against the live instance on 2026-08-27. Passing the token back as `roster_cursor` advanced from `Anne Watson, Anthony Tran, Arjun Valapparambil Sunilkumar` to `Brittany Celata, Camille Roubik, Carrie Smaha`, in correct keyset order with a fresh cursor.

The reproduction passed `cursor`. `search_people` has no such parameter, because it pages two independent arrays and names them `people_cursor` and `roster_cursor`. The argument was unrecognized, dropped, and the query restarted, producing exactly the reported symptom.

Request 9 is therefore closed as filed and reopened as this phase. Its open question, whether `people` scope shares the defect, is answered: no defect exists in either scope. `people_cursor` was not separately exercised, and that is recorded rather than asserted.

**A contributing factor is the surface itself.** `export_data`, `list_due`, and `list_encounters` all page with a plain `cursor`. `search_people` is the exception. A caller that learned `cursor` from three tools reaches for it on the fourth. P3 adds `list_roster_entries`, which makes `search_people` a further outlier. The alias in P3 addresses this; validation makes the mistake loud in the meantime.

### Design

Every tool's declared `inputSchema` becomes enforceable at call time. Arguments that are not in the schema are refused. Arguments of the wrong type are refused. Required arguments that are absent are refused.

Refusals use the existing closed set of error codes and carry `invalid_input`. The message names what was rejected and what was expected, because the reader is a model deciding what to do next, and a refusal that does not say what would have worked costs a round trip.

The first task of this phase is a test that reproduces the silent drop, so the fix is demonstrated against a failure rather than assumed. This ordering is not optional: the defect is inferred from a code read and a matching symptom, and it has not been reproduced end to end.

### Blast radius

This changes refusal behaviour on all 28 tools. Calls that previously succeeded while quietly ignoring an argument will now fail. That is the intent, and it is a behaviour change on a live instance in daily use, so it is called out here rather than discovered.

## P3 - Read surface

The organizing rule for this phase, chosen over extending `search_people` with structured filters: **search is for text, list is for filters.** A model selects the right tool from its name rather than from a combination of six optional parameters. This matches the project's existing preference for many explicit tools over few general ones.

### Tool surface after this phase

| Tool | Change |
|---|---|
| `search_people` | Text only. Roster results gain `external_row_key`. Accepts `cursor` conditionally |
| `get_roster_entry` | Gains `external_row_key` |
| `list_records` | Renamed from `export_data`. Gains `include`, `updated_after`, `tags` |
| `list_roster_entries` | New |
| `list_tags` | New |

### `list_records`, renamed from `export_data`

**Hard rename, no alias.** The name says backup and the description says paginated read-back, so whichever is right the other misleads. This cost a real round trip in use, where the name led the operator to assume the tool was for backups and question why it was being called during ordinary check-ins.

A hard rename is safe here because the operator is the only caller and clients re-read the tool list each session. A registry guard test asserts `export_data` is absent, so the rename cannot silently regress.

The new description drops the "it is not the backup" clause, which answered a question nobody asked, and instead names the two real paths by name: the P0 wrangler dump for recovery, and the P5 export for archives.

### `include`

`include: ["tags", "links", "contacts"]` applies to `scope: "people"`. Each requested relation is joined and returned inline.

Confirming that a tagging pass ran previously required calling `get_person` per record and generalizing from a sample. At 42 people that is 42 calls for a routine question. The same gap hid a real change, where links were empty on an early check and populated later, surfacing only because one person happened to be re-fetched.

**Encounters and follow-ups always carry `person_name` inline, with no opt-in.** They currently return `person_id` and nothing else, which forces a lookup per row merely to learn who the encounter was with. A bare id is not useful to any caller, so this is not made optional.

**`include` is refused on the `encounters` and `followups` scopes**, rather than accepted and ignored. Person identity is already inline there and no other relations exist, so any value a caller sends is a misunderstanding worth reporting. This is stated because P2's validation cannot infer it from the schema alone.

**Response size.** When `include` is non-empty the maximum `limit` drops from 500 to 100, and the description says so. The people set stays small because roster entries live in their own tool, so this cap is a guard rather than a routine constraint.

### `updated_after`

An ISO timestamp. Returns only records whose `updated_at` is later. Applies to all three scopes.

Every check-in during real use was a form of "what changed since we last looked", and the only available answer was to pull the full set and compare against conversation history. That works at 42 people and does not work at 400.

`people.updated_at` is `NOT NULL`, verified in migration 0001, so the filter is total on that scope. `encounters` and `followups` both carry `updated_at` but their current select lists omit it; this phase adds it, since a caller cannot record a watermark from a field it never receives.

**No tombstones.** A delete becomes invisible to a delta caller, who sees only that the record is gone from a full list. For a single-user PRM that is sufficient, and a tombstone table is a durable cost for a rare event.

### `tags` filter and `list_tags`

A `tags` filter on `list_records(scope: "people")`, matching exactly, with AND semantics across multiple tags.

`search_people` matches tags today, but as free text across name, organization, title, notes, tags, and email together, so searching `speaker` also returns everyone whose job title contains the word. The vocabulary is being written and cannot be queried precisely.

**The `tags` filter is refused on the `encounters` and `followups` scopes**, for the same reason `include` is: tags attach to people, and silently ignoring the filter would return a full unfiltered page that looks like an answer.

`list_tags` returns each tag in use with a count of people carrying it. It doubles as a hygiene tool: near-duplicates such as `speaker` and `speakers` become visible as soon as they appear.

### `list_roster_entries`

Optional `source_key`, `role`, `promoted`, and `organization`. No text query.

Roster entries carry a `role` field, but `search_people` in roster scope requires a text query, so there is no way to ask for all rows with a given role or to page the roster at all without inventing search terms. The concrete blocked task is "promote all speakers", which currently requires knowing their names in advance.

The `promoted` boolean is the other half: everything not yet promoted is the natural working queue and is currently unaskable.

### `external_row_key`

Returned by `search_people` in roster scope and by `get_roster_entry`.

`import_roster` treats `external_row_key` as row identity, but nothing in the read surface returns it, so a promotion pipeline cannot connect a source row to the entry it created. The WCUS migration matched on `full_name` instead, which worked only because all 35 promoted names happened to be unique among 798 rows. That roster contains eleven duplicated names, so it was luck rather than a property of the design.

**Option 1 only.** `promote_roster_entry` does not gain the ability to accept `source_key` plus `external_row_key` in place of a `roster_entry_id`. Returning the field makes the existing pipeline verifiable, which is the defect being closed. Removing the resolution step entirely is a larger change and is not required by anything.

### The `cursor` alias

`search_people` accepts a plain `cursor` when `scope` is `people` or `roster`, where the intended array is unambiguous. With `scope: "all"` it is refused, naming both real parameters.

**The cost is accepted deliberately:** this is a tool whose accepted arguments depend on another argument's value. It is chosen over strict naming because a model reaching for the familiar name is the common case and the current outcome is a wrong answer.

Two rules keep it honest:

- `cursor` is declared in the schema as an ordinary optional string, and the scope-dependence is enforced in the tool body. Conditional JSON Schema would be harder to read and would put the rule somewhere the error message cannot reach.
- Supplying `cursor` together with `people_cursor` or `roster_cursor` is refused as ambiguous rather than resolved by precedence. The existing check on the token's `kind` field stays, so a roster token presented as `cursor` under `scope: "people"` is still caught.

### Migration

One migration, `0009`, adding indexes only:

- `people(updated_at)`, `encounters(updated_at)`, `followups(updated_at)` for `updated_after`.
- Whatever `person_tags` requires in the tag-to-person direction for the tags filter, determined by reading the existing indexes rather than assumed here.
- Any index `list_roster_entries` needs for `role` and `promoted` filtering.

Additive and index-only, so either deploy order is safe.

## P4 - `update_followup`

`update_followup(followup_id, note?, due_on?)`, updating whichever fields are supplied and leaving the rest alone.

Follow-ups can be created, completed, and cancelled, but not changed. Neither available workaround is correct. Cancelling and recreating writes `cancelled_at` on a follow-up that was never abandoned, so the history lies and no future reader can distinguish a real cancellation from a bookkeeping one. Creating a second follow-up puts two open items on one person for one obligation, which inflates the single number `list_due` exists to report.

Due dates have the same problem. Four follow-ups currently share one date because it was chosen when the first was created, and moving one means destroying and rebuilding it.

**Editing a completed or cancelled follow-up is refused.** Fixing a typo on a closed item is rare, and refusing keeps the closed record honest.

Completion and cancellation stay as they are. Those are state transitions with their own semantics and they already work.

No schema change: `followups` already carries `note`, `due_on`, and `updated_at`.

## P5 - JSON archival export

`npm run export`, a local Node CLI. Not a Worker route, for the reason the original spec gives: a copy inside the account is not a backup of that account.

**Authentication is loopback OAuth.** `src/auth/provider.ts:58` defines the loopback hosts and line 80 implements the native-app exception permitting `http` to a loopback address. The CLI uses the flow that already exists, so no new credential enters the system and the property that the project holds no secret of the user's survives.

**Output is one JSON file** covering every record kind, including the contacts, links, and tags that `list_records` alone does not return, plus a manifest carrying counts per scope, the `schema_version` reported by `/health`, and the export timestamp. It reuses P3's join work directly.

**It is explicitly not a restore.** The tested restore remains plan 3. Recovery is the P0 wrangler dump, which is a database rather than a projection of one. Saying this plainly in the spec, in the CLI's own output, and in the `list_records` description prevents an archive being mistaken for a recovery path at the moment somebody needs one.

## Testing

This project's own record sets the standard. Seventeen tests across plans 1 and 2 passed, were named for the right thing, and guarded nothing. Not one was caught by the suite going red; every one was found by a reviewer reading an assertion against its input. A frozen test clock separately hid three live bugs.

Three rules apply to every test written for this spec:

**State what the test fails on.** Each new test carries, in its name or a comment, the change that would make it fail.

**Confirm the mutation is real before trusting a green suite.** Breaking the code underneath a test and watching the suite stay green proves the test is blind only if the mutation was a genuine behaviour change. An earlier finding in this project was withdrawn for exactly this reason: an index supplied the ordering a removed sort tiebreak had been credited with, so the mutation changed nothing and the suite was right to stay green.

**`updated_after` gets a mutable clock.** It is the clock-dependent feature in this spec, and a frozen instant is what hid three defects previously.

Two specific guards:

- A registry test asserting `export_data` is absent, so the hard rename cannot regress.
- A test reproducing the silent argument drop, written before the validation fix, so P2 is demonstrated against a real failure.

## Deferred, and why

**Batch writes (request 3), which asks that `log_encounter`, `add_link`, and `add_contact` each accept an array as well as a single record, returning per-item results so a partial failure is legible.** The case for it: a conference debrief produced eleven separate `log_encounter` calls, and one person alone carried five links. Changes the input shape of three shipped tools rather than adding to them, and raises questions this spec does not need to answer: all-or-nothing versus partial success, and how one idempotency key covers many items. A conference arriving as a burst is the canonical case and it deserves its own design.

**`merge_people` (request 4), which asks for a preview-then-confirm merge moving encounters, follow-ups, contacts, links, tags, and provenance from one person record onto another.** The case for it: promotion previews duplicates and so prevents them at promotion time, but once two person records exist the only remedy is `delete_person`, which is permanent and discards whatever the losing record carried. Needs a tombstone or a `merged_into` column so a merged id stays resolvable, which is the first durable schema change in this body of work. It also needs a preview-then-confirm shape matching `purge_roster_source`.

**Multi-person encounters (request 5), which asks that one encounter record carry several attendees rather than being split into one record per person.** The case for it: two people met together at the same event produce two encounters with overlapping summaries, so the story is complete in neither and editing it later means editing it twice. `encounters.person_id` is `NOT NULL` with a direct foreign key, verified in migration 0005. Supporting several attendees means a join table and rebuilding the `encounters` table on a live D1 holding real records. That is the highest-risk change in the whole set and it does not belong beside index additions.

**`get_summary` (ref A), which asks for counts by scope, the most recent encounter date, and the open follow-up count in a single call.** The case for it: reporting "42 people, 11 encounters, 2 open follow-ups" required pulling every full record across three calls and still missed tags and links. The request itself observes that `include` and `updated_after` landing may remove the need. Revisit after P3 has been in use.

## Open questions

- The exact `wrangler d1 export` flag set for P0, confirmed when the runbook is written.
- Whether `add_contact` deduplicates. Settled by the P0 spike, and it determines P1's wording for `promote_roster_entry`.
- Whether the `k:` discriminator is guaranteed stable, which P1 must state one way or the other.
- Which indexes `person_tags` and `roster_entries` already have, which decides how much of migration 0009 is actually new.

## Verification notes, 2026-08-27

Recorded because these were checked rather than recalled, and because vendor and library behaviour changes.

- Roster pagination advances correctly. Proven against the live instance with `limit: 3`, two pages, correct keyset order.
- The live instance holds 798 roster entries, 0 stale, 39 promoted, last imported `2026-08-27T04:55:22.523Z`.
- `src/mcp/server.ts:41` passes `inputSchema` through to the low-level `Server`. No Zod parsing or argument validation exists in `src/mcp/transport.ts` or `src/mcp/server.ts`.
- `src/normalize.ts:130` builds `external_row_key` with the `k:` / `e:` / `h:` discriminator.
- `src/auth/provider.ts:58` and line 80 confirm loopback redirect support.
- `people.updated_at` is `NOT NULL` (migration 0001). `encounters.person_id` is `NOT NULL` with a foreign key (migration 0005).
- The suite is 475 tests across 37 files, all passing, with a clean typecheck.
- No export CLI or backup script exists. `package.json` has two scripts, `test` and `typecheck`.
