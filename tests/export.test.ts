import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { addContact, addLink, addTags } from "../src/tools/attributes";
import { logEncounter } from "../src/tools/encounters";
import { listRecords } from "../src/tools/export";
import { createFollowup } from "../src/tools/followups";
import { TOOLS } from "../src/tools/index";
import { archivePerson, createPerson } from "../src/tools/people";
import { encodeCursor } from "../src/paginate";

// A MUTABLE clock. A frozen instant makes every updated_after boundary test
// pass whether or not the filter actually compares against it.
// Milliseconds are non-zero on purpose: truncating a watermark to whole
// seconds must move it strictly backward for the truncation test below to
// mean anything. A round-second start makes that truncation a no-op.
let now = new Date("2026-08-20T12:00:00.250Z");
const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => now,
};
const clock = {
  advance(ms: number) {
    now = new Date(now.getTime() + ms);
  },
  now: () => now,
};

async function readUpdatedAt(personId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT updated_at FROM people WHERE id = ?")
    .bind(personId)
    .first<{ updated_at: string }>();
  if (!row) throw new Error(`no person ${personId}`);
  return row.updated_at;
}

beforeEach(async () => {
  now = new Date("2026-08-20T12:00:00.250Z");
  await env.DB.prepare("DELETE FROM people").run();
});

describe("listRecords", () => {
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
    expect(result.records.map((r) => (r as { id: string }).id)).not.toContain(person.id);
  });

  it("includes archived people when asked", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    await archivePerson(ctx, { person_id: person.id });
    const result = await listRecords(ctx, { scope: "people", archived: true });
    expect(result.records.map((r) => (r as { id: string }).id)).toContain(person.id);
  });

  it("defaults to people and returns whole records", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    const out = await listRecords(ctx, {});
    expect(out.scope).toBe("people");
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toEqual(
      expect.objectContaining({ full_name: "Ada Lovelace", organization: "Kinsta" })
    );
  });

  it("pages with a cursor and terminates, in id order, at the right boundaries", async () => {
    for (let i = 0; i < 5; i++) {
      await createPerson(ctx, { full_name: `Person ${i}` });
    }

    const pageSizes: number[] = [];
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listRecords(ctx, { scope: "people", limit: 2, cursor });
      pageSizes.push(page.records.length);
      seen.push(...page.records.map((r) => (r as { id: string }).id));
      cursor = page.next_cursor ?? undefined;
      pages++;
      if (pages > 10) throw new Error("list_records did not terminate");
    } while (cursor !== undefined);

    // Boundaries, not just membership: 5 rows at limit 2 is 2, 2, 1 - not
    // 3 pages of arbitrary size that happen to sum to 5.
    expect(pageSizes).toEqual([2, 2, 1]);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // The keyset is `id ASC`; each page's rows must continue the previous
    // page's order, not just avoid repeats.
    expect(seen).toEqual([...seen].sort());
  });

  it("lists encounters and follow-ups under their own scopes", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await logEncounter(ctx, { person_id: person.id, summary: "hallway track" });
    await createFollowup(ctx, { person_id: person.id, due_on: "2026-09-01", note: "send deck" });

    const encounters = await listRecords(ctx, { scope: "encounters" });
    expect(encounters.records).toHaveLength(1);

    const followups = await listRecords(ctx, { scope: "followups" });
    expect(followups.records).toHaveLength(1);
  });

  it("never lists staged roster data", async () => {
    await expect(listRecords(ctx, { scope: "roster_entries" as never })).rejects.toThrow(ToolError);
    try {
      await listRecords(ctx, { scope: "roster_entries" as never });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_input");
    }
  });

  it("refuses a scope inherited from Object.prototype rather than running it as SQL", async () => {
    // QUERIES was a plain object literal, so QUERIES["toString"] resolved to
    // Function.prototype.toString, the `base === undefined` guard passed, and
    // the function's source text went into the SQL. The call came back as
    // `D1_ERROR: near "function": syntax error` - a raw error with no `code`,
    // outside the closed set of seven that clients and tests bind to.
    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      try {
        await listRecords(ctx, { scope: inherited as never });
        throw new Error(`expected a refusal for scope ${inherited}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolError);
        expect((e as ToolError).code).toBe("invalid_input");
      }
    }
  });

  // The brief this test file was drafted from described `limit: 0` and
  // `limit: 10_000` as clamped to the floor/ceiling. `clampLimit` in
  // src/paginate.ts - the shared helper every other list tool in this repo
  // already depends on (search.ts, followups.ts, encounters_read.ts) - throws
  // in both cases instead of clamping, and its own test suite
  // (tests/paginate.test.ts) asserts that on purpose: a silent clamp tells the
  // agent it received everything owed. Rewriting clampLimit to clamp instead
  // of throw would be a second pagination dialect and would break every tool
  // that already relies on the throwing behavior, so this test is corrected to
  // match the shipped convention rather than the stale brief text.
  it("rejects a limit below the floor rather than silently raising it to one", async () => {
    await createPerson(ctx, { full_name: "Floor Case" });
    try {
      await listRecords(ctx, { scope: "people", limit: 0 });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_input");
    }
  });

  it("rejects a limit above the ceiling rather than silently truncating", async () => {
    for (let i = 0; i < 3; i++) await createPerson(ctx, { full_name: `Person ${i}` });
    try {
      await listRecords(ctx, { scope: "people", limit: 10_000 });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("limit_exceeded");
    }
  });

  it("rejects a cursor this server did not issue", async () => {
    try {
      await listRecords(ctx, { scope: "people", cursor: "not-a-real-cursor" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_input");
    }
  });

  it("rejects a cursor whose id belongs to a different scope", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "hallway track" });
    // Well-formed per decodeCursor - a plain object with a string `id` - but
    // the id is an encounter id, not a person id.
    const foreignCursor = encodeCursor({ id: encounter.id });
    try {
      await listRecords(ctx, { scope: "people", cursor: foreignCursor });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_id");
    }
  });
});

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
    expect(new Set(result.records.map((r) => (r as { id: string }).id)).size).toBe(3);
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
      cursor: first.next_cursor ?? undefined,
    });
    const ids = [...first.records, ...second.records].map((r) => (r as { id: string }).id);
    expect(new Set(ids).size).toBe(5);
  });

  it("attaches each relation to the right person", async () => {
    const ada = await createPerson(ctx, { full_name: "Ada" });
    const grace = await createPerson(ctx, { full_name: "Grace" });
    await addTags(ctx, { person_id: ada.id, tags: ["speaker"] });
    await addTags(ctx, { person_id: grace.id, tags: ["organizer"] });
    const result = await listRecords(ctx, { scope: "people", include: ["tags"] });
    const byId = Object.fromEntries(
      result.records.map((r) => [(r as { id: string }).id, r as { tags: string[] }])
    );
    expect(byId[ada.id]?.tags).toEqual(["speaker"]);
    expect(byId[grace.id]?.tags).toEqual(["organizer"]);
  });

  it("returns an empty array, not a missing key, for a person with no relations", async () => {
    const p = await createPerson(ctx, { full_name: "Nobody" });
    const result = await listRecords(ctx, { scope: "people", include: ["tags", "links"] });
    const row = result.records.find((r) => (r as { id: string }).id === p.id) as {
      tags: string[];
      links: unknown[];
    };
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

  // The Task 8 test covering a filter (tags) narrowing the page while include
  // is active is deferred to Task 8, which is where the tags filter itself
  // lands. It is not written here per the controller ruling recorded in the
  // run ledger for this task.
});

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
    expect(result.records.map((r) => (r as { id: string }).id)).toContain(person.id);
  });

  it("excludes a record updated exactly at the watermark", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const at = await readUpdatedAt(person.id);
    const result = await listRecords(ctx, { scope: "people", updated_after: at });
    expect(result.records.map((r) => (r as { id: string }).id)).not.toContain(person.id);
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
    expect(result.records.map((r) => (r as { id: string }).id)).toContain(person.id);
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

  it("returns every record when more than one page shares a timestamp", async () => {
    // The clock does not advance, so all five share an instant.
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await createPerson(ctx, { full_name: `P${i}` }));
    const watermark = new Date(clock.now().getTime() - 1000).toISOString();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await listRecords(ctx, { scope: "people", updated_after: watermark, limit: 2, cursor });
      r.records.forEach((x) => seen.add((x as { id: string }).id));
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
    expect(seen.size).toBe(made.length);
  });

  it("does not return the same record twice across pages", async () => {
    for (let i = 0; i < 4; i++) await createPerson(ctx, { full_name: `Q${i}` });
    const watermark = new Date(clock.now().getTime() - 1000).toISOString();
    const first = await listRecords(ctx, { scope: "people", updated_after: watermark, limit: 2 });
    const second = await listRecords(ctx, {
      scope: "people",
      updated_after: watermark,
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    const ids = [...first.records, ...second.records].map((r) => (r as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Date.parse accepts "2026-08-27", "08/27/2026", and "1". The project has an
  // ISO-instant contract; use it rather than accepting whatever parses.
  it("refuses a date with no time, which Date.parse would otherwise accept", async () => {
    await expect(
      listRecords(ctx, { scope: "people", updated_after: "2026-08-27" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // The first draft's test was named for encounters and follow-ups and
  // exercised only encounters, leaving the follow-up path unguarded.
  it("applies to follow-ups", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const watermark = clock.now().toISOString();
    clock.advance(60_000);
    await createFollowup(ctx, { person_id: person.id, due_on: "2026-09-09" });
    const result = await listRecords(ctx, { scope: "followups", updated_after: watermark });
    expect(result.records).toHaveLength(1);
  });
});
