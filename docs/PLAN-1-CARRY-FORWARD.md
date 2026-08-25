# Plan 1 - what plan 2 and plan 3 need to know

Written 2026-08-25, when plan 1 merged to `master` as `0355934`.

The execution ledger that produced this branch was scratch and has been trashed. Everything below
is the part of it that outlives the branch: constraints a later plan can break without noticing,
decisions taken on Matt's behalf, and known gaps that were parked deliberately rather than missed.
The git history carries the rest.

## Constraints plan 2 can break without noticing

**`delete_person`'s stored idempotency response is redacted, and it must stay redacted.**
`withIdempotency` takes a redaction hook; `deletePerson` passes one that drops `full_name` before
the response is persisted. Without it, the one tool that exists to answer an erasure request leaves
the erased person's name in `idempotency_keys` under a NULL subject, where the scrub cannot reach
it. **Any key-reclaim or retention design in plan 2 has to preserve this** - a reclaimed and re-run
`delete_person` would otherwise re-store the name.

**A caller-visible consequence of that:** a first `delete_person` call returns a full
`DeletePreview`; a replay returns a redacted one, so `deleted.full_name` is optional on the union.
Nothing reads it outside the delete path today.

**`today` is applied at the registry seam by `envelope()`, not per tool.** Every tool result carries
the current date in the owner's time zone. A transport that calls tool modules directly rather than
through `TOOLS` silently drops it, and no per-tool test would catch that.

**The three lookup maps are prototype-hardened on purpose.** `QUERIES` and `ID_PREFIX` in
`src/tools/export.ts` and `TOOLS` in `src/tools/index.ts` are built with a null prototype. Before
that, `export_data({scope: "toString"})` resolved up the prototype chain to
`Function.prototype.toString` and concatenated a function's source text into SQL, returning a raw
D1 error carrying no code. `TOOLS` is the map plan 2's transport will index by tool name.

**Nothing enforces the registry's input schemas.** Every tool declares `additionalProperties:
false`, `required`, `enum`, and `pattern`, and none of it runs - the schemas are data waiting for a
transport. Plan 2 owns making them real. Until it does, `occurred_at` is writable on encounters only
because nothing checks the schema that omits it; that field is now declared, but the general point
stands.

**Staleness reads `committed_run_id`, never `last_seen_run_id`,** and the source's latest committed
run is selected by one shared constant in `src/tools/latest_run.ts`, ordered by `rowid DESC`. Ids
are random UUIDs, so ordering by `id` is a coin flip rather than a tiebreak. Three byte-identical
copies of that CTE existed and two were reachable by no test.

## Decisions taken on Matt's behalf that he may want to revisit

**`update_person` and `update_encounter` are marked `destructiveHint: true`.** They overwrite free
text a user wrote and nothing retains the previous value. `archive_person`, `unarchive_person`,
`complete_followup` and `cancel_followup` stay `false`: they write one guarded server timestamp and
destroy nothing a user authored. The doc comment above them still carries a gloss - "an UPDATE
counts; an INSERT does not" - that contradicts its own governing sentence and would have those four
over-marked. **The annotations are right; that gloss should go.**

**The fix wave was scoped to eleven items.** Everything else from the whole-branch review was parked
rather than dropped; the ones with teeth are below.

## Known gaps, parked deliberately

**The duplicate prefilter is blind to non-ASCII uppercase.** D1's `LOWER()` is ASCII-only:
`SELECT LOWER('ÉLODIE Martin')` returns `Élodie martin`, so probing for `Élodie Martin` against a
stored `ÉLODIE Martin` returns no duplicate candidate at all. The module comment names only NFKC and
internal whitespace runs, so it understates this. Closing it means normalizing every candidate row
in JavaScript on every probe - a design decision with a cost, not a patch. **On a roster with
accented names, the duplicate check silently does less than the spec promises.**

**`log_encounter` has no follow-up argument** although the spec's tool list says "person, when,
where, what happened, optional follow-up." It was built without one and nobody noticed until the
registry was written. Adding it is a design decision with a known hazard: it could double-create a
follow-up if the agent also calls `create_followup`.

**`export_data` has no `contacts`, `links`, or `tags` scopes.** A user who asks for their data gets
no email address, phone number, website, or tag. The whole-branch review calls this a spec gap
rather than an implementation defect - the spec never enumerates the scopes.

**`withIdempotency` has a permanent-wedge crash window.** A claim commits, the mutation commits, and
if the isolate dies before `response_json` is written the claim is stuck with no TTL.
`idempotency_keys` has no `expires_at`, unlike `confirmations`. Inert while no transport exists;
real the day plan 2 puts a Worker with a CPU limit in front of this. The recommended fix is a TTL
reclaim - `created_at` older than a stated window plus `response_json IS NULL` - rather than forcing
every tool's writes into one `db.batch()`, which `createPerson` and `promoteRosterEntry` cannot be.

**`import_state.ts` names the wrong corrective call** when a run is already full: it says "send at
most 0 row(s) at offset N" where the true next call is `finalize_import`.

**Nothing addresses D1's 500 MB free-plan limit.**

**`import_runs.status = 'abandoned'` is unreachable.** The CHECK permits it and `finalizeImport`
handles it, but no code sets it, so there is no way to close a run that was opened and never
finished. They accumulate, inertly.

## What this branch's history is actually evidence for

Twenty-one tasks were each reviewed at the task level, and four multi-agent review rounds had been
run against the plan before any code existed. **Ten tests still shipped that passed, were named for
the right thing, and guarded nothing** - and the Critical the whole-branch review found, a duplicate
check that stops working at 25 matching rows, survived every one of those gates because no test
staged more than a handful of rows.

Three separate live defects were invisible because every `ToolContext` in the suite uses one frozen
instant. A fourth was looked for deliberately and does not exist.

The suite is 341 tests across 24 files. It was verified stable across 16 consecutive full runs after
a cross-file pollution bug was fixed - `vitest.config.ts` sets `isolate: false`, so every file
shares one D1 instance and cleanup ordering between files matters.
