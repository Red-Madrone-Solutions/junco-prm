# Junco PRM Read Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make routine questions cost one call rather than one per record, let a roster row be matched back to its source, and let a follow-up be corrected without falsifying its history.

**Architecture:** One organizing rule, applied throughout: search is for text, list is for filters. `search_people` splits so each search tool returns one array and pages with one plainly named `cursor`. `export_data` becomes `list_records` and gains `include`, `updated_after`, `tags`, and `archived`. Two new list tools and one new write tool. One migration, adding indexes only.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, vitest 4.1.11 with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-27-junco-prm-read-surface-and-export-design.md` (phases P4 and P5)

**This is plan 3 of 3.** Plan 1 builds the backup and must run first. Plan 2 adds argument validation and must run before this one: this plan introduces four tools and eight parameters, and adding them to a surface that silently swallows unknown arguments multiplies the failure mode rather than containing it.

**Tool count: 28 becomes 32.**

## Global Constraints

- **No em dashes or en dashes anywhere**, in code, comments, docs, or commit messages. Plain hyphens only.
- **No `console` calls anywhere in `src/`** except `src/log.ts`.
- **The seven error codes are a closed set.** Adding an eighth is a spec change.
- **D1 binds at most 100 parameters per statement.** `docs/MEASUREMENTS.md` records this as still binding and `KEY_LOOKUP_CHUNK` is 99 because of it. No design here may bind a page of ids.
- **Every new tool declares all three MCP annotations**, uses `obj(..., { idempotent: true })` if it writes, and states a default and maximum page size if it pages.
- **Every read tool pages with `cursor`**, on the shared helpers in `src/paginate.ts`. Nothing rolls its own token.
- **Plans 1 and 2 must have been executed.** Take a Time Travel bookmark before the migration and before each deploy, per `docs/BACKUP.md`.

---

## File Structure

**Created:**

- `migrations/0009_read_surface_indexes.sql`
- `src/tools/search_roster.ts` - text search over roster entries, split out of `search.ts`.
- `src/tools/list_tags.ts`
- `src/tools/list_roster.ts` - `list_roster_entries`, structured filters.
- `tests/` files matching each.

**Modified:**

- `src/tools/attributes.ts` - all six relation writers bump `people.updated_at`.
- `src/tools/search.ts` - loses roster scope.
- `src/tools/export.ts` - becomes `list_records`, gains four parameters.
- `src/tools/followups.ts` - gains `updateFollowup`.
- `src/tools/roster_admin.ts` - `get_roster_entry` returns `external_row_key`.
- `src/tools/encounters_read.ts` and `src/tools/export.ts` - both select encounters; both need `updated_at`.
- `src/tools/index.ts` - four new registrations, one rename, several schema changes.

---

### Task 1: `update_followup`

Independent of everything else here, and small. It ships first so the plan produces something useful before the larger changes begin.

Follow-ups can be created, completed, and cancelled, but not changed. Cancelling and recreating writes `cancelled_at` on a follow-up that was never abandoned, so the history lies. Creating a second puts two open items on one person for one obligation, inflating the single number `list_due` exists to report.

**Files:**
- Modify: `src/tools/followups.ts`
- Modify: `src/tools/index.ts`
- Modify: `tests/followups.test.ts`

**Interfaces:**
- Consumes: `withIdempotency`, `loadFollowup`, `assertId`, `nowIso`, `ToolError`, all already in `src/tools/followups.ts`.
- Produces: `updateFollowup(ctx: ToolContext, input: UpdateFollowupInput): Promise<Followup>`, where `UpdateFollowupInput = { followup_id: string; note?: string | null; due_on?: string; idempotency_key?: string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// in tests/followups.test.ts, matching the file's existing harness
describe("updateFollowup", () => {
  it("changes the note and leaves the due date alone", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09", note: "first" });
    const updated = await updateFollowup(ctx, { followup_id: fu.id, note: "first, and the LinkedIn message" });
    expect(updated.note).toBe("first, and the LinkedIn message");
    expect(updated.due_on).toBe("2026-09-09");
  });

  it("changes the due date and leaves the note alone", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09", note: "keep me" });
    const updated = await updateFollowup(ctx, { followup_id: fu.id, due_on: "2026-10-01" });
    expect(updated.due_on).toBe("2026-10-01");
    expect(updated.note).toBe("keep me");
  });

  it("clears the note when null is sent, which is different from omitting it", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09", note: "temporary" });
    const updated = await updateFollowup(ctx, { followup_id: fu.id, note: null });
    expect(updated.note).toBeNull();
  });

  // Without this a caller can spend a write, an idempotency key, and a round
  // trip to change nothing, and be told it worked.
  it("refuses a call that supplies neither field", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09" });
    await expect(updateFollowup(ctx, { followup_id: fu.id })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a due date that is not YYYY-MM-DD", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09" });
    await expect(
      updateFollowup(ctx, { followup_id: fu.id, due_on: "next Tuesday" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses to edit a completed follow-up", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09" });
    await completeFollowup(ctx, { followup_id: fu.id });
    await expect(
      updateFollowup(ctx, { followup_id: fu.id, note: "too late" })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses to edit a cancelled follow-up", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09" });
    await cancelFollowup(ctx, { followup_id: fu.id });
    await expect(
      updateFollowup(ctx, { followup_id: fu.id, note: "too late" })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("reports not_found for an id that does not exist", async () => {
    await expect(
      updateFollowup(ctx, { followup_id: "fu_00000000-0000-0000-0000-000000000000", note: "x" })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("moves updated_at", async () => {
    const fu = await createFollowup(ctx, { person_id: p, due_on: "2026-09-09" });
    clock.advance(60_000);
    const updated = await updateFollowup(ctx, { followup_id: fu.id, note: "later" });
    expect(updated.updated_at).not.toBe(fu.updated_at);
  });
});
```

The `clock.advance` call requires a mutable clock. If the surrounding file pins one instant, add a mutable clock for this describe block only, and say in a comment that a frozen clock has hidden three live defects in this project already.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/followups.test.ts`
Expected: FAIL, `updateFollowup` is not exported.

- [ ] **Step 3: Implement it**

Add to `src/tools/followups.ts`, following `closeFollowup`'s shape exactly:

```typescript
export interface UpdateFollowupInput {
  followup_id: string;
  note?: string | null;
  due_on?: string;
  idempotency_key?: string;
}

export async function updateFollowup(
  ctx: ToolContext,
  input: UpdateFollowupInput
): Promise<Followup> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(
    ctx,
    "update_followup",
    idempotency_key,
    rest,
    async () => {
      const id = assertId("fu", input.followup_id);

      // `note` may be explicitly null, which clears it, so presence is what
      // matters rather than truthiness.
      const setsNote = Object.prototype.hasOwnProperty.call(input, "note");
      const setsDue = input.due_on !== undefined;
      if (!setsNote && !setsDue) {
        throw new ToolError(
          "invalid_input",
          "update_followup needs note, due_on, or both",
          "call it again with the field you mean to change"
        );
      }
      if (setsDue && !/^\d{4}-\d{2}-\d{2}$/.test(input.due_on as string)) {
        throw new ToolError("invalid_input", "due_on must be YYYY-MM-DD");
      }

      const sets: string[] = [];
      const binds: (string | null)[] = [];
      if (setsNote) {
        sets.push("note = ?");
        binds.push(input.note ?? null);
      }
      if (setsDue) {
        sets.push("due_on = ?");
        binds.push(input.due_on as string);
      }
      sets.push("updated_at = ?");
      binds.push(nowIso(ctx.clock));

      // Conditional on both closed columns in the same statement. A read then
      // a write can race with a completion landing between them and would edit
      // a closed record. Same guard closeFollowup uses, for the same reason.
      const result = await ctx.db
        .prepare(
          `UPDATE followups SET ${sets.join(", ")}
           WHERE id = ? AND completed_at IS NULL AND cancelled_at IS NULL`
        )
        .bind(...binds, id)
        .run();

      if (result.meta.changes === 0) {
        const existing = await ctx.db
          .prepare("SELECT id FROM followups WHERE id = ?")
          .bind(id)
          .first<{ id: string }>();
        if (!existing) throw new ToolError("not_found", `no follow-up with id ${id}`);
        throw new ToolError(
          "conflict",
          `follow-up ${id} is closed and cannot be edited`,
          "a closed follow-up is a record of what happened; create a new one instead"
        );
      }

      return loadFollowup(ctx, id);
    },
    undefined,
    (followup) => followup.person_id
  );
}
```

- [ ] **Step 4: Register it**

In `src/tools/index.ts`, import `updateFollowup` alongside the other follow-up imports, and add:

```typescript
    define(
      "update_followup",
      "Change an open follow-up's note or due date. Send note or due_on or both; " +
        "send note as null to clear it. A completed or cancelled follow-up cannot be " +
        "edited, because a closed follow-up is a record of what happened.",
      DESTRUCTIVE,
      obj(
        {
          followup_id: id("fu", "Follow-up"),
          note: nullableStr("Replaces the existing note. Null clears it."),
          due_on: str("New due date, YYYY-MM-DD."),
        },
        ["followup_id"],
        { idempotent: true }
      ),
      updateFollowup
    ),
```

**`DESTRUCTIVE`, not `WRITE_IDEMPOTENT`.** It overwrites a note the user wrote and nothing retains the previous text, which is the rule the registry already applies to `update_person` and `update_encounter`. A client using these hints to decide what to run without asking would otherwise auto-approve destroying a note.

- [ ] **Step 5: Run and commit**

Run: `npm test` and `npm run typecheck`
Expected: PASS, 29 tools registered.

```bash
git add src/tools/followups.ts src/tools/index.ts tests/followups.test.ts
git commit -m "feat: add update_followup so a follow-up can be corrected without a false cancellation"
```

---

### Task 2: Relation writes must move `people.updated_at`

**This task is why `updated_after` can exist.** No writer in `src/tools/attributes.ts` touches `people.updated_at`: `addContact`, `addLink`, `addTags`, `removeContact`, `removeLink`, and `removeTags` all write child tables and return `getPerson`, and none issues an `UPDATE people`. Verified by grep: zero matches.

Without this, `updated_after` misses every tag, link, and contact change, and the failure is asymmetric and silent. `update_person` does bump the timestamp, so deltas look like they work. Run a tagging pass Monday, ask what changed Tuesday, and be told nothing did. That is precisely the check `include` exists to serve.

**Files:**
- Modify: `src/tools/attributes.ts`
- Modify: `tests/attributes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the guarantee `updated_after` depends on in Task 7.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/attributes.test.ts
describe("relation writes and people.updated_at", () => {
  // Table-driven so a seventh relation writer added later cannot quietly skip
  // the bump. Each case is a separate live defect if it fails.
  const cases: [string, (personId: string) => Promise<unknown>][] = [
    ["add_contact", (p) => addContact(ctx, { person_id: p, contact_type: "email", value: "a@b.test" })],
    ["add_link", (p) => addLink(ctx, { person_id: p, link_type: "website", url: "https://b.test" })],
    ["add_tags", (p) => addTags(ctx, { person_id: p, tags: ["speaker"] })],
    ["remove_tags", (p) => removeTags(ctx, { person_id: p, tags: ["speaker"] })],
  ];

  for (const [name, write] of cases) {
    it(`${name} moves people.updated_at`, async () => {
      const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
      if (name === "remove_tags") await addTags(ctx, { person_id: person.id, tags: ["speaker"] });
      const before = await readUpdatedAt(person.id);
      clock.advance(60_000);
      await write(person.id);
      expect(await readUpdatedAt(person.id)).not.toBe(before);
    });
  }

  it("remove_contact and remove_link move it too", async () => {
    const person = await createPerson(ctx, { full_name: "Grace Hopper" });
    const withContact = await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "g@h.test",
    });
    const before = await readUpdatedAt(person.id);
    clock.advance(60_000);
    await removeContact(ctx, { person_id: person.id, contact_id: withContact.contacts[0].id });
    expect(await readUpdatedAt(person.id)).not.toBe(before);
  });
});
```

Add `readUpdatedAt` as a helper selecting `updated_at` from `people` by id. **Use a mutable clock.** A frozen instant makes every one of these tests pass whether or not the bump happens, which is the exact failure that hid three live defects in this project.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/attributes.test.ts`
Expected: FAIL on every case, because `updated_at` is unchanged.

**If they pass, stop.** Either the clock is frozen or the bump already exists, and both mean this task's premise is wrong.

- [ ] **Step 3: Add the bump to all six writers**

In each of `addContact`, `addLink`, `addTags`, `removeContact`, `removeLink`, and `removeTags`, include this statement in the same `db.batch` as the child write:

```typescript
        ctx.db
          .prepare("UPDATE people SET updated_at = ? WHERE id = ?")
          .bind(nowIso(ctx.clock), personId),
```

Where a writer does not currently use `db.batch`, convert it to one. **The bump and the child write must be in the same batch.** Two separate statements can leave the child written and the timestamp stale, which produces exactly the silent gap this task exists to close, only intermittently.

`addTags` already uses `db.batch`, so it is the pattern to copy.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/attributes.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the tests are not blind**

Remove the bump from `addTags` only. Run again. Expected: FAIL on `add_tags moves people.updated_at` and nothing else. Restore it and confirm PASS. This proves the table-driven test discriminates between writers rather than passing on one bump for all six.

- [ ] **Step 6: Run everything and commit**

Run: `npm test`
Expected: PASS. Watch for existing tests that assert an exact `updated_at`; those need updating deliberately.

```bash
git add src/tools/attributes.ts tests/attributes.test.ts
git commit -m "fix: relation writes now move people.updated_at, so deltas can see them"
```

---

### Task 3: Migration 0009

Indexes only. Additive, so either deploy order is safe: new code without the index is correct but slower, the index without new code is inert.

**Files:**
- Create: `migrations/0009_read_surface_indexes.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: indexes Tasks 7, 8, and 9 rely on for speed, never for correctness.

- [ ] **Step 1: Confirm what is already indexed**

```bash
grep -n "CREATE INDEX\|PRIMARY KEY" migrations/0001_durable_core.sql migrations/0002_staged_and_provenance.sql migrations/0005_encounters_followups.sql
```

Expected, and already established: `person_tags` has `PRIMARY KEY (person_id, tag_id)` and nothing else, so the tag-to-person direction is unindexed. `roster_entries` has indexes on `roster_source_id`, `last_seen_run_id`, `full_name`, `email`, and `committed_run_id`, and nothing on `role`.

- [ ] **Step 2: Write the migration**

```sql
-- migrations/0009_read_surface_indexes.sql
--
-- Indexes only. Nothing here changes a table, so this migration and the deploy
-- that uses it are safe in either order: the new code is correct without these
-- and merely slower, and these are inert without the new code.

-- list_records(updated_after: ...) on all three durable scopes.
CREATE INDEX idx_people_updated ON people(updated_at);
CREATE INDEX idx_encounters_updated ON encounters(updated_at);
CREATE INDEX idx_followups_updated ON followups(updated_at);

-- list_records(tags: [...]) walks tag to person. person_tags has only
-- PRIMARY KEY (person_id, tag_id), which cannot serve that direction.
CREATE INDEX idx_person_tags_tag ON person_tags(tag_id, person_id);

-- list_roster_entries(role: ...). Always scoped to a source in practice, so
-- the source column leads.
CREATE INDEX idx_roster_entries_role ON roster_entries(roster_source_id, role);

-- Deliberately absent: anything for list_roster_entries(promoted: ...).
-- "Promoted" is not a column. It is a correlated lookup into person_sources on
-- (source_key, external_row_key), and that side is already covered by the
-- UNIQUE constraint in migration 0002. There is nothing on roster_entries to
-- index, so that filter scans the source's rows. At 798 that is fine, and
-- saying so here is better than a future reader assuming an index was missed.
```

- [ ] **Step 3: Apply locally and run the suite**

The test harness reads `migrations/` through `readD1Migrations`, so the suite applies this automatically.

Run: `npm test`
Expected: PASS. A migration that fails to parse fails here, before it reaches a real database.

- [ ] **Step 4: Confirm the planner will use them**

```bash
npx wrangler d1 execute junco-prm --local --command \
  "EXPLAIN QUERY PLAN SELECT id FROM people WHERE updated_at > '2026-01-01' ORDER BY id LIMIT 10"
```

Expected: the plan mentions `idx_people_updated`. If it does not, record that in `docs/MEASUREMENTS.md` rather than adding more indexes: an index the planner declines is a fact worth knowing, and the filter is still correct without it.

- [ ] **Step 5: Commit**

```bash
git add migrations/0009_read_surface_indexes.sql
git commit -m "feat: add migration 0009, indexes for the new read filters"
```

---

### Task 4: Split `search_people` into two tools

**Files:**
- Modify: `src/tools/search.ts`
- Create: `src/tools/search_roster.ts`
- Modify: `src/tools/roster_admin.ts`
- Modify: `src/tools/index.ts`
- Modify: `tests/search.test.ts`, create `tests/search_roster.test.ts`

**Interfaces:**
- Consumes: `encodeCursor`, `decodeCursor`, `clampLimit` from `src/paginate.ts`.
- Produces:
  - `searchPeople(ctx, { query, limit?, cursor?, include_archived? })` returning `{ people, next_cursor }`.
  - `searchRosterEntries(ctx, { query, limit?, cursor? })` returning `{ roster_entries, next_cursor }`, each entry carrying `external_row_key`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/search_roster.test.ts
describe("searchRosterEntries", () => {
  it("returns one array and one cursor", async () => {
    const result = await searchRosterEntries(ctx, { query: "Mark", limit: 3 });
    expect(Array.isArray(result.roster_entries)).toBe(true);
    expect(result).not.toHaveProperty("people");
    expect(result).not.toHaveProperty("roster_next_cursor");
  });

  // The whole reason for the split. The old shape took people_cursor and
  // roster_cursor and returned two arrays; a real caller reached for `cursor`,
  // had it silently dropped, got the same page back, and filed a pagination bug.
  it("pages with a plain cursor", async () => {
    const first = await searchRosterEntries(ctx, { query: "a", limit: 2 });
    const second = await searchRosterEntries(ctx, { query: "a", limit: 2, cursor: first.next_cursor });
    const firstIds = first.roster_entries.map((e) => e.id);
    const secondIds = second.roster_entries.map((e) => e.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it("returns external_row_key so a source row can be matched to its entry", async () => {
    const result = await searchRosterEntries(ctx, { query: "Rory" });
    expect(result.roster_entries[0]).toHaveProperty("external_row_key");
  });

  it("refuses a cursor issued by a different tool", async () => {
    const people = await searchPeople(ctx, { query: "a", limit: 1 });
    await expect(
      searchRosterEntries(ctx, { query: "a", cursor: people.next_cursor })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// tests/search.test.ts, added
describe("searchPeople after the split", () => {
  it("returns one array and no roster results", async () => {
    const result = await searchPeople(ctx, { query: "a" });
    expect(result).not.toHaveProperty("roster_entries");
    expect(result).not.toHaveProperty("people_next_cursor");
    expect(result).toHaveProperty("next_cursor");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/search_roster.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Move the roster branch into its own module**

Cut the `scope === "roster" || scope === "all"` branch from `src/tools/search.ts` (currently around lines 276 to 377) into `src/tools/search_roster.ts` as `searchRosterEntries`. Keep the SQL as it is; this is a move, not a rewrite. Three changes as it moves:

- The input takes `cursor`, not `roster_cursor`, and the result returns `next_cursor`.
- The cursor's `kind` stays `"roster"`, so a people cursor presented here is still refused by the existing check.
- The selected columns gain `re.external_row_key`, and the mapped entry carries it.

Then remove `scope` from `searchPeople` entirely, along with the roster arrays and the two prefixed cursor names, and rename its cursor to `cursor` and `next_cursor`.

- [ ] **Step 4: Return `external_row_key` from `get_roster_entry` too**

In `src/tools/roster_admin.ts`, add `external_row_key` to the selected columns and the returned shape of `getRosterEntry`.

- [ ] **Step 5: Register the new tool and update the old one**

In `src/tools/index.ts`:

```typescript
    define(
      "search_roster_entries",
      "Free-text search over staged roster entries: names, organizations, and job titles. " +
        "Returns external_row_key, the identity the import assigned each row, so a source row " +
        "can be matched back to its entry. NOTE: when no source id was supplied at import, that " +
        "key is derived from the person's email address and therefore contains it. " +
        "For filtering by role or promotion state rather than text, use list_roster_entries.",
      READ,
      obj(
        {
          query: str("Search text. Treated as literal text, never as query syntax."),
          limit: int("Maximum results, 1 to 50. Defaults to 20."),
          cursor: str("Page token from a previous next_cursor."),
        },
        ["query"]
      ),
      searchRosterEntries
    ),
```

Change `search_people`'s description to say it searches people only, and remove `scope`, `people_cursor`, and `roster_cursor` from its schema, replacing them with `cursor`.

**The PII sentence in that description is deliberate and is not decoration.** `src/normalize.ts:130` builds tier 2 of the key as `e:` plus the normalized email, and `src/tools/search.ts` already excludes `raw_record` from roster results because they go "straight into a model's context, often immediately before a write against one of these records". Returning the key reintroduces a third party's address into exactly that result. The field is needed and is returned as-is, because an opaque digest defeats the join-back use case that is the whole point. Saying what it can contain is the mitigation.

- [ ] **Step 6: Run everything**

Run: `npm test`

Expected: FAIL in existing tests that call `searchPeople` with `scope` or read `roster_entries` from its result. Update each deliberately: a call with `scope: "roster"` becomes a `searchRosterEntries` call.

Then: PASS, and `npm run typecheck` clean, with 30 tools registered.

- [ ] **Step 7: Commit**

```bash
git add src/tools/search.ts src/tools/search_roster.ts src/tools/roster_admin.ts src/tools/index.ts tests/
git commit -m "feat: split search_people, so each search tool has one array and one cursor"
```

---

### Task 5: `export_data` becomes `list_records`, and gains `archived`

**Files:**
- Modify: `src/tools/export.ts`
- Modify: `src/tools/index.ts`
- Modify: `tests/export.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `listRecords(ctx, input)`, exported under that name. `EXPORT_SCOPES` becomes `LIST_SCOPES`.

- [ ] **Step 1: Write the failing tests**

```typescript
it("is absent from the registry under its old name", () => {
  // The rename is hard, with no alias. This is the guard that stops it
  // silently coming back, and it costs one line.
  expect(Object.keys(TOOLS)).not.toContain("export_data");
  expect(Object.keys(TOOLS)).toContain("list_records");
});

it("excludes archived people by default", async () => {
  const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
  await archivePerson(ctx, { person_id: person.id });
  const result = await listRecords(ctx, { scope: "people" });
  expect(result.records.map((r) => r.id)).not.toContain(person.id);
});

it("includes archived people when asked", async () => {
  const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
  await archivePerson(ctx, { person_id: person.id });
  const result = await listRecords(ctx, { scope: "people", archived: true });
  expect(result.records.map((r) => r.id)).toContain(person.id);
});
```

**The archived default is a change in behaviour, not just an addition.** `export_data` returns archived people today with no way to exclude them, while `search_people` excludes them by default. Two read tools with opposite defaults, one with no filter, is a wrong count waiting to happen. This aligns them.

- [ ] **Step 2: Run to verify they fail, then rename**

Rename `exportData` to `listRecords` and `EXPORT_SCOPES` to `LIST_SCOPES` in `src/tools/export.ts`, keeping the null-prototype `QUERIES` map and the scope allowlist exactly as they are. Both exist because of a live defect where `export_data({scope: "toString"})` concatenated `Function.prototype.toString`'s source into the SQL, and neither is incidental.

Add an `archived` boolean to the people query, defaulting to excluding them.

- [ ] **Step 3: Re-register it**

In `src/tools/index.ts`, replace the `define("export_data", ...)` call:

```typescript
    define(
      "list_records",
      "List durable records a page at a time, filtered by scope. Use this to read back what is " +
        "in Junco: all people, all encounters, or all open follow-ups. For one person with their " +
        "tags, links, and contacts, use get_person. This is not the backup; backup and restore " +
        "are run from the command line and are documented in docs/BACKUP.md.",
      READ,
      obj(
        {
          scope: enumOf(["people", "encounters", "followups"], "Which records to return."),
          archived: bool("Include archived people. People scope only. Defaults to false."),
          limit: int("Page size, 1 to 500. Defaults to 100."),
          cursor: str("Page token from a previous next_cursor."),
        },
        []
      ),
      listRecords
    ),
```

Note `required` is `[]`, not `["scope"]`. Plan 2 Task 3 resolved that drift in the handler's favour; re-introducing it here would undo that.

- [ ] **Step 4: Run, fix callers, commit**

Run: `npm test`. Update every test and caller naming `export_data` or `exportData`.

```bash
git add src/tools/export.ts src/tools/index.ts tests/
git commit -m "feat: rename export_data to list_records and align its archived default with search"
```

---

### Task 6: `include`

**Files:**
- Modify: `src/tools/export.ts`
- Modify: `tests/export.test.ts`

**Interfaces:**
- Consumes: `listRecords` from Task 5.
- Produces: `list_records(scope: "people", include: [...])` returning relations inline.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("list_records include", () => {
  // THE TEST THAT MATTERS. The obvious implementation joins the relation
  // tables, which makes row count stop meaning person count: a person with
  // three tags eats three rows of the limit, the page returns fewer people
  // than asked for, and the cursor lands on a row rather than a person.
  it("returns exactly the requested number of distinct people when they carry many relations", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await createPerson(ctx, { full_name: `Person ${i}` });
      await addTags(ctx, { person_id: p.id, tags: ["a", "b", "c"] });
      await addLink(ctx, { person_id: p.id, link_type: "website", url: "https://a.test" });
      await addLink(ctx, { person_id: p.id, link_type: "linkedin", url: "https://b.test" });
      await addContact(ctx, { person_id: p.id, contact_type: "email", value: `p${i}@t.test` });
    }
    const result = await listRecords(ctx, {
      scope: "people",
      include: ["tags", "links", "contacts"],
      limit: 3,
    });
    expect(result.records).toHaveLength(3);
    expect(new Set(result.records.map((r) => r.id)).size).toBe(3);
  });

  it("pages without repeating or skipping a person", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await createPerson(ctx, { full_name: `Person ${i}` });
      await addTags(ctx, { person_id: p.id, tags: ["a", "b"] });
    }
    const first = await listRecords(ctx, { scope: "people", include: ["tags"], limit: 3 });
    const second = await listRecords(ctx, {
      scope: "people",
      include: ["tags"],
      limit: 3,
      cursor: first.next_cursor,
    });
    const ids = [...first.records, ...second.records].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("attaches each relation to the right person", async () => {
    const ada = await createPerson(ctx, { full_name: "Ada" });
    const grace = await createPerson(ctx, { full_name: "Grace" });
    await addTags(ctx, { person_id: ada.id, tags: ["speaker"] });
    await addTags(ctx, { person_id: grace.id, tags: ["organizer"] });
    const result = await listRecords(ctx, { scope: "people", include: ["tags"] });
    const byId = Object.fromEntries(result.records.map((r) => [r.id, r]));
    expect(byId[ada.id].tags).toEqual(["speaker"]);
    expect(byId[grace.id].tags).toEqual(["organizer"]);
  });

  it("returns an empty array, not a missing key, for a person with no relations", async () => {
    const p = await createPerson(ctx, { full_name: "Nobody" });
    const result = await listRecords(ctx, { scope: "people", include: ["tags", "links"] });
    const row = result.records.find((r) => r.id === p.id);
    expect(row.tags).toEqual([]);
    expect(row.links).toEqual([]);
  });

  it("caps the page size lower when include is used", async () => {
    await expect(
      listRecords(ctx, { scope: "people", include: ["tags"], limit: 500 })
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("refuses include on scopes that have no relations", async () => {
    await expect(
      listRecords(ctx, { scope: "encounters", include: ["tags"] })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/export.test.ts`
Expected: FAIL, `include` is not a parameter.

- [ ] **Step 3: Implement, binding no id list**

```typescript
const INCLUDE_MAX_LIMIT = 100;

/**
 * One statement per relation, binding NO list of person ids.
 *
 * Two wrong ways to do this, both of which fail only at scale:
 *
 * A join against person_tags or person_contacts is one-to-many, so row count
 * stops meaning person count. A page of 100 returns fewer than 100 people and
 * the keyset lands on the last ROW rather than the last person.
 *
 * Paging people first and then binding their ids collides with D1's 100
 * parameter ceiling, which docs/MEASUREMENTS.md records as still binding and
 * which is why KEY_LOOKUP_CHUNK is 99. A hundred ids consumes the entire
 * budget, leaving none for the other filters, and it fails at exactly the
 * maximum a caller is most likely to ask for.
 *
 * So the page predicate is repeated as a subquery instead. Three extra
 * statements, no id list, no interaction with the parameter cap.
 */
async function loadRelations(
  ctx: ToolContext,
  include: string[],
  pagePredicate: { sql: string; binds: unknown[] }
): Promise<Record<string, Record<string, unknown[]>>> {
  const out: Record<string, Record<string, unknown[]>> = {};

  if (include.includes("tags")) {
    const rows = await ctx.db
      .prepare(
        `SELECT pt.person_id, t.name
         FROM person_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.person_id IN (${pagePredicate.sql})
         ORDER BY t.name`
      )
      .bind(...pagePredicate.binds)
      .all<{ person_id: string; name: string }>();
    out.tags = {};
    for (const row of rows.results) (out.tags[row.person_id] ??= []).push(row.name);
  }

  if (include.includes("links")) {
    const rows = await ctx.db
      .prepare(
        `SELECT id, person_id, link_type, url FROM person_links
         WHERE person_id IN (${pagePredicate.sql}) ORDER BY id`
      )
      .bind(...pagePredicate.binds)
      .all<{ id: string; person_id: string; link_type: string; url: string }>();
    out.links = {};
    for (const row of rows.results) {
      const { person_id, ...link } = row;
      (out.links[person_id] ??= []).push(link);
    }
  }

  if (include.includes("contacts")) {
    const rows = await ctx.db
      .prepare(
        `SELECT id, person_id, contact_type, value, label FROM person_contacts
         WHERE person_id IN (${pagePredicate.sql}) ORDER BY id`
      )
      .bind(...pagePredicate.binds)
      .all<{ id: string; person_id: string; contact_type: string; value: string; label: string | null }>();
    out.contacts = {};
    for (const row of rows.results) {
      const { person_id, ...contact } = row;
      (out.contacts[person_id] ??= []).push(contact);
    }
  }

  return out;
}
```

In `listRecords`, build the page predicate as the same `SELECT id FROM people WHERE <filters> ORDER BY id LIMIT ?` used for the page itself, pass it to `loadRelations`, and attach `tags`, `links`, and `contacts` to each record, defaulting to `[]`.

Refuse `include` on the encounter and follow-up scopes with `invalid_input`, and clamp the limit to `INCLUDE_MAX_LIMIT` with `limit_exceeded` when `include` is non-empty.

**Returned shapes match what already exists** rather than inventing a second shape for the same thing: tags as `string[]`, matching `PersonHit.tags` in `search.ts`; contacts as `{id, contact_type, value, label}`; links as `{id, link_type, url}`.

- [ ] **Step 4: Add `include` to the schema**

```typescript
          include: strArray(
            'Relations to return inline on people. Any of "tags", "links", "contacts". ' +
              "Page size is capped at 100 when this is used."
          ),
```

- [ ] **Step 5: Run and confirm the fan-out test is not blind**

Run: `npx vitest run tests/export.test.ts` - expected PASS.

Then replace `loadRelations` with a single `LEFT JOIN` against `person_tags` in the main query. Expected: the "exactly the requested number of distinct people" test FAILS, returning fewer than 3. Revert and confirm PASS. That mutation is the whole reason the subquery approach exists, and a test that survives it is not testing anything.

- [ ] **Step 6: Commit**

```bash
git add src/tools/export.ts tests/export.test.ts src/tools/index.ts
git commit -m "feat: include tags, links, and contacts inline without breaking pagination"
```

---

### Task 7: `updated_after`

**Files:**
- Modify: `src/tools/export.ts`, `src/tools/encounters_read.ts`
- Modify: `tests/export.test.ts`

**Interfaces:**
- Consumes: Task 2's guarantee that relation writes move `people.updated_at`.
- Produces: `list_records(updated_after: "<ISO instant>")` on all three scopes.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("updated_after", () => {
  // Task 2 exists for this test. Without the bump it returns nothing and
  // reports that nothing changed, which is the exact check `include` was added
  // to serve.
  it("sees a tag added after the watermark", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    clock.advance(60_000);
    const watermark = clock.now().toISOString();
    clock.advance(60_000);
    await addTags(ctx, { person_id: person.id, tags: ["speaker"] });

    const result = await listRecords(ctx, { scope: "people", updated_after: watermark });
    expect(result.records.map((r) => r.id)).toContain(person.id);
  });

  it("excludes a record updated exactly at the watermark", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const at = (await readUpdatedAt(person.id));
    const result = await listRecords(ctx, { scope: "people", updated_after: at });
    expect(result.records.map((r) => r.id)).not.toContain(person.id);
  });

  // The silent one. updated_at is TEXT compared lexicographically, and
  // isIsoInstant makes milliseconds optional. A caller sending
  // 2026-08-27T12:00:00Z against a stored 2026-08-27T12:00:00.500Z compares
  // "Z" (0x5A) with "." (0x2E), so the stored value sorts LOWER and vanishes.
  // Every record updated in the same second as the watermark disappears from
  // the delta, on every iteration of a watermark loop.
  it("finds a record updated in the same second as a watermark with no milliseconds", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const stored = await readUpdatedAt(person.id); // ends .sssZ
    const truncated = stored.replace(/\.\d+Z$/, "Z");
    // Truncating moves the watermark BACKWARD, so the record must be included.
    const result = await listRecords(ctx, { scope: "people", updated_after: truncated });
    expect(result.records.map((r) => r.id)).toContain(person.id);
  });

  it("refuses a timestamp it cannot parse", async () => {
    await expect(
      listRecords(ctx, { scope: "people", updated_after: "last Tuesday" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("applies to encounters and follow-ups too", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const watermark = clock.now().toISOString();
    clock.advance(60_000);
    await logEncounter(ctx, { person_id: person.id, occurred_on: "2026-08-27", summary: "met" });
    const result = await listRecords(ctx, { scope: "encounters", updated_after: watermark });
    expect(result.records).toHaveLength(1);
  });
});
```

**Use a mutable clock throughout this describe block.** A frozen instant makes the boundary tests meaningless.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/export.test.ts`
Expected: FAIL, `updated_after` is not a parameter.

- [ ] **Step 3: Implement with canonicalization**

```typescript
/**
 * Canonicalize before comparing. updated_at is TEXT and SQLite compares it
 * lexicographically, which is correct between two stored values and wrong
 * against caller input: `isIsoInstant` accepts a timestamp with no
 * milliseconds, and "Z" sorts above ".", so a truncated watermark silently
 * excludes every record written in that same second.
 *
 * Exclusive, which is what a watermark loop wants: a caller records the
 * newest updated_at it saw and passes it back, and must not be handed the
 * same record again.
 */
function canonicalInstant(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ToolError(
      "invalid_input",
      "updated_after must be an ISO 8601 instant, for example 2026-08-27T12:00:00.000Z"
    );
  }
  return new Date(parsed).toISOString();
}
```

Append `AND updated_at > ?` to each scope's query when `updated_after` is present, binding the canonical form.

- [ ] **Step 4: Add `updated_at` to the select lists that omit it**

`export.ts`'s `QUERIES` and `encounters_read.ts`'s exported `COLUMNS` both select encounters and neither carries `updated_at`. A caller cannot record a watermark from a field it never receives.

**Decide and record which you are doing.** Adding `updated_at` to the shared `COLUMNS` changes the response shape of `log_encounter`, `update_encounter`, `delete_encounter`, `get_person`, and `list_encounters` at once, because `toEncounter` spreads the row. That is defensible and arguably right, and it means idempotency records stored before this change replay the old shape on a retry. The alternative is a separate column list for `list_records`. Pick one, do it, and say which in the commit message.

- [ ] **Step 5: Add to the schema and the description**

```typescript
          updated_after: str(
            "ISO instant. Returns only records updated strictly after it, so a watermark can be " +
              "passed straight back. Deletions are not reported: a deleted record is simply absent " +
              "from a full listing."
          ),
```

- [ ] **Step 6: Confirm the boundary test is not blind**

Replace `canonicalInstant` with `(v) => v`, returning the caller's string unchanged. Run again. Expected: the same-second test FAILS. Revert and confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/export.ts src/tools/encounters_read.ts src/tools/index.ts tests/
git commit -m "feat: add updated_after, canonicalized so a truncated watermark cannot hide records"
```

---

### Task 8: `tags` filter and `list_tags`

**Files:**
- Modify: `src/tools/export.ts`
- Create: `src/tools/list_tags.ts`, `tests/list_tags.test.ts`
- Modify: `src/tools/index.ts`

**Interfaces:**
- Consumes: `normalizeText` from `src/normalize.ts`.
- Produces: `listTags(ctx, input): Promise<{ tags: {name, people_count}[] }>`, and a `tags` filter on `list_records`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("tags filter", () => {
  // Tag names are stored lowercased through normalizeText, and add_tags and
  // remove_tags both normalize on the way in. A literal match against
  // "Speaker" returns a well-formed empty page: a model echoing list_tags
  // output would be fine, a model working from a human's phrasing would not.
  it("matches regardless of the case the caller sends", async () => {
    const p = await createPerson(ctx, { full_name: "Ada" });
    await addTags(ctx, { person_id: p.id, tags: ["speaker"] });
    const result = await listRecords(ctx, { scope: "people", tags: ["Speaker"] });
    expect(result.records.map((r) => r.id)).toContain(p.id);
  });

  it("requires all tags, not any of them", async () => {
    const both = await createPerson(ctx, { full_name: "Both" });
    const one = await createPerson(ctx, { full_name: "One" });
    await addTags(ctx, { person_id: both.id, tags: ["speaker", "sponsor"] });
    await addTags(ctx, { person_id: one.id, tags: ["speaker"] });
    const result = await listRecords(ctx, { scope: "people", tags: ["speaker", "sponsor"] });
    const ids = result.records.map((r) => r.id);
    expect(ids).toContain(both.id);
    expect(ids).not.toContain(one.id);
  });

  it("refuses tags on scopes that have none", async () => {
    await expect(
      listRecords(ctx, { scope: "encounters", tags: ["speaker"] })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("listTags", () => {
  it("returns each tag with a count of the people carrying it", async () => {
    const a = await createPerson(ctx, { full_name: "A" });
    const b = await createPerson(ctx, { full_name: "B" });
    await addTags(ctx, { person_id: a.id, tags: ["speaker"] });
    await addTags(ctx, { person_id: b.id, tags: ["speaker"] });
    const result = await listTags(ctx, {});
    expect(result.tags).toContainEqual({ name: "speaker", people_count: 2 });
  });

  // removeTags never deletes the tags row, and delete_person cascades
  // person_tags but not tags, so orphans accumulate. Showing them is the point:
  // spotting "speaker" beside "speakers" is what this tool is for, and an inner
  // join would hide exactly the rows worth seeing.
  it("includes tags nobody currently carries", async () => {
    const p = await createPerson(ctx, { full_name: "A" });
    await addTags(ctx, { person_id: p.id, tags: ["orphan"] });
    await removeTags(ctx, { person_id: p.id, tags: ["orphan"] });
    const result = await listTags(ctx, {});
    expect(result.tags).toContainEqual({ name: "orphan", people_count: 0 });
  });

  // A count that silently includes archived people is a wrong number, and
  // list_records and search_people already disagree about archived by default.
  it("does not count archived people", async () => {
    const p = await createPerson(ctx, { full_name: "A" });
    await addTags(ctx, { person_id: p.id, tags: ["speaker"] });
    await archivePerson(ctx, { person_id: p.id });
    const result = await listTags(ctx, {});
    expect(result.tags).toContainEqual({ name: "speaker", people_count: 0 });
  });
});
```

- [ ] **Step 2: Run to verify they fail, then implement**

```typescript
// src/tools/list_tags.ts
import type { ToolContext } from "../context";

export interface ListTagsInput {
  cursor?: string;
  limit?: number;
}

export async function listTags(ctx: ToolContext, input: ListTagsInput) {
  // LEFT JOIN, not INNER: a tag nobody carries is exactly what makes this
  // useful as a hygiene tool. Archived people are excluded from the count
  // rather than from the tag, so the tag still appears with a lower number.
  const rows = await ctx.db
    .prepare(
      `SELECT t.name AS name,
              COUNT(p.id) AS people_count
       FROM tags t
       LEFT JOIN person_tags pt ON pt.tag_id = t.id
       LEFT JOIN people p ON p.id = pt.person_id AND p.archived_at IS NULL
       GROUP BY t.id, t.name
       ORDER BY t.name`
    )
    .all<{ name: string; people_count: number }>();
  return { tags: rows.results.map((r) => ({ name: r.name, people_count: Number(r.people_count) })) };
}
```

For the `tags` filter on `list_records`, add one `AND` clause per requested tag, each an `EXISTS` against `person_tags` joined to `tags`, with the name normalized through `normalizeText`. `EXISTS` per tag gives AND semantics without a `GROUP BY ... HAVING COUNT` and without binding a list.

**Bound the tag count.** Each tag is one bound parameter and one subquery; refuse more than 10 with `limit_exceeded` so the 100-parameter ceiling cannot be reached from this direction.

- [ ] **Step 3: Register `list_tags`**

```typescript
    define(
      "list_tags",
      "Every tag in use, with how many people carry it. Tags with a count of zero are included " +
        "on purpose: seeing 'speaker' beside 'speakers' is what makes this useful. Archived " +
        "people are not counted.",
      READ,
      obj({}, []),
      listTags
    ),
```

- [ ] **Step 4: Run, then commit**

Run: `npm test` and `npm run typecheck`. Expected: PASS, 31 tools.

```bash
git add src/tools/list_tags.ts src/tools/export.ts src/tools/index.ts tests/
git commit -m "feat: filter people by tag, and list the tag vocabulary with counts"
```

---

### Task 9: `list_roster_entries`

**Files:**
- Create: `src/tools/list_roster.ts`, `tests/list_roster.test.ts`
- Modify: `src/tools/index.ts`

**Interfaces:**
- Consumes: `encodeCursor`, `decodeCursor`, `clampLimit`.
- Produces: `listRosterEntries(ctx, { source_key?, role?, organization?, promoted?, limit?, cursor? })`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("listRosterEntries", () => {
  it("returns every entry for a source when no filter is given", async () => {
    const result = await listRosterEntries(ctx, { source_key: "wcus-2026-attendees", limit: 5 });
    expect(result.roster_entries.length).toBeGreaterThan(0);
    expect(result.next_cursor).toBeTruthy();
  });

  // The blocked task this tool exists for: promote all speakers, without
  // knowing their names in advance.
  it("filters by role", async () => {
    const result = await listRosterEntries(ctx, { role: "speaker" });
    expect(result.roster_entries.every((e) => e.role === "speaker")).toBe(true);
  });

  // The natural working queue, and currently unaskable.
  it("filters to entries not yet promoted", async () => {
    const result = await listRosterEntries(ctx, { promoted: false, limit: 5 });
    expect(result.roster_entries.every((e) => e.promoted_person_id === null)).toBe(true);
  });

  it("filters to entries already promoted", async () => {
    const result = await listRosterEntries(ctx, { promoted: true, limit: 5 });
    expect(result.roster_entries.every((e) => e.promoted_person_id !== null)).toBe(true);
  });

  it("returns external_row_key", async () => {
    const result = await listRosterEntries(ctx, { limit: 1 });
    expect(result.roster_entries[0]).toHaveProperty("external_row_key");
  });

  // 759 unpromoted rows on the real roster, so paging is not optional and a
  // one-page test proves nothing about it.
  it("pages through more rows than one page holds without repeating", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await listRosterEntries(ctx, { limit: 2, cursor });
      for (const e of result.roster_entries) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});
```

- [ ] **Step 2: Implement**

Keyset on `(full_name, id)` with an explicit tiebreak, matching what the roster search already does. `promoted` is derived through an `EXISTS` against `person_sources` on `(source_key, external_row_key)`; there is no column to compare and no index to add, which migration 0009 records deliberately.

Default limit 20, maximum 50, matching the search tools. `role` and `organization` are stored as imported rather than normalized, so state in the description that they match exactly, including case.

- [ ] **Step 3: Register**

```typescript
    define(
      "list_roster_entries",
      "Staged roster entries by filter rather than by text: source, role, organization, and " +
        "whether each has been promoted. promoted: false is the working queue of people not yet " +
        "recorded. role and organization match exactly, including case, because roster rows are " +
        "stored as imported. Returns external_row_key, which can contain an email address when " +
        "the import supplied no source id. For text search, use search_roster_entries.",
      READ,
      obj(
        {
          source_key: str("Limit to one roster source."),
          role: str("Exact role as imported, for example \"speaker\"."),
          organization: str("Exact organization as imported."),
          promoted: bool("True for entries already promoted, false for those not yet promoted."),
          limit: int("Page size, 1 to 50. Defaults to 20."),
          cursor: str("Page token from a previous next_cursor."),
        },
        []
      ),
      listRosterEntries
    ),
```

- [ ] **Step 4: Run and commit**

Run: `npm test` and `npm run typecheck`. Expected: PASS, **32 tools**.

Add a registry test asserting the count is 32, so a later task cannot add or drop a tool without noticing.

```bash
git add src/tools/list_roster.ts src/tools/index.ts tests/
git commit -m "feat: add list_roster_entries, so the roster can be filtered rather than searched"
```

---

### Task 10: Migrate, deploy, and exercise it

**Files:**
- Modify: `docs/MEASUREMENTS.md`

- [ ] **Step 1: Confirm the preconditions**

```bash
ls -t junco-backup-*.json.bz2 | head -1
npx wrangler d1 time-travel info junco-prm
```

An archive must exist, from plan 1. Record the bookmark. **This is the first plan of the three that changes the schema of a live database.**

- [ ] **Step 2: Apply the migration to the remote database**

```bash
npx wrangler d1 migrations apply junco-prm --remote
```

Expected: `0009_read_surface_indexes.sql` applied. Indexes only, so this is safe before the deploy and inert until it.

- [ ] **Step 3: Deploy**

```bash
npm test && npm run typecheck && npx wrangler deploy
```

Record the version id. That is the rollback target.

- [ ] **Step 4: Exercise the four new tools and the renamed one, through the connector**

Not `curl`. Through Claude, against the live instance holding the real WCUS roster:

- `list_records(scope: "people", include: ["tags", "links", "contacts"])` returns every person with relations inline, and the count matches `list_records(scope: "people")`.
- `list_records(scope: "people", updated_after: <an hour ago>)` returns only what moved.
- Add a tag to one person, then re-run that same `updated_after` call. **The person must now appear.** This is the live proof of Task 2, and it is the check that would have failed silently before it.
- `list_tags()` returns the real vocabulary. Look for near-duplicates.
- `list_roster_entries({promoted: false, limit: 5})` returns unpromoted entries, and paging with the cursor advances.
- `search_roster_entries({query: "Mark", limit: 3})` and then the same call with `cursor` set. **The second page must differ from the first.** This is the original reported defect, exercised against the shape that replaced it.
- `export_data` is gone. Confirm the tool list shows 32 tools and no `export_data`.

- [ ] **Step 5: Record it**

In `docs/MEASUREMENTS.md`: the date, the version id, the migration, that all six checks above passed, and anything surprising. Record the `list_tags` output too; the tag vocabulary of a real roster is worth having written down.

- [ ] **Step 6: If anything fails**

```bash
npx wrangler rollback
```

The migration does not need reverting. It adds indexes, which are inert without the code that uses them.

- [ ] **Step 7: Commit**

```bash
git add docs/MEASUREMENTS.md
git commit -m "docs: record the read surface deploy and its live exercise"
```

---

## Self-Review

**Spec coverage.** P4 maps as: the search split is Task 4, `list_records` and `archived` are Task 5, `include` with its stated no-id-list mechanism is Task 6, `updated_after` with canonicalization and exclusivity is Task 7 and depends on Task 2, the `tags` filter and `list_tags` with their two decided behaviours are Task 8, `list_roster_entries` with a full pagination contract is Task 9, `external_row_key` and its PII statement are in Tasks 4 and 9, and migration 0009 is Task 3. P5 is Task 1. The per-phase live verification is Task 10.

**One spec item is implemented differently from how the spec describes it.** The spec says encounters and follow-ups "always carry `person_name` inline". Task 7 Step 4 raises this as a decision rather than doing it silently, because adding a column to the shared `COLUMNS` changes five tools' response shapes at once and makes stored idempotency records replay the old shape. The spec lists that exact trade as an open question, so it is surfaced at the point of decision rather than resolved here by assumption.

**Placeholder scan.** No TBD or TODO. Task 4 Step 3 describes a code move rather than quoting the ~100 lines being moved, and names the exact line range and the three changes to make during the move; that is a procedure over existing code, not a placeholder. Task 9 Step 2 states the keyset, the derivation, the defaults, and the matching rules rather than quoting a full implementation, and every one of its behaviours is pinned by a test in Step 1.

**Type consistency.** `listRecords` is named in Task 5 and used under that name in Tasks 6, 7, and 8. `LIST_SCOPES` replaces `EXPORT_SCOPES` in Task 5 and is not referred to by the old name afterwards. `searchRosterEntries` and `listRosterEntries` are distinct throughout and both return `{ ..., next_cursor }`. `updateFollowup(ctx, input)` matches `closeFollowup`'s shape in `src/tools/followups.ts`, including the `(followup) => followup.person_id` subject callback. The relation shapes in Task 6 match `PersonHit.tags` and the `person_contacts` and `person_links` columns as migration 0001 declares them.

**Two risks carried deliberately.** Task 4 is a breaking change to a shipped tool on an instance in daily use; it is mitigated by Task 10's rollback and by clients re-reading `tools/list` each session. And Task 2 changes the write path of six tools that every other feature here depends on, which is why it ships alone, second, with a mutation step proving its test discriminates between writers.
