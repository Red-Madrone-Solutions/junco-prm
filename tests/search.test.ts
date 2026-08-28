import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { addContact, addTags } from "../src/tools/attributes";
import { createPerson } from "../src/tools/people";
import { searchPeople } from "../src/tools/search";
import { searchRosterEntries } from "../src/tools/search_roster";

const T = "2026-08-20T00:00:00Z";
const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date(T),
};

async function seedRoster() {
  await env.DB.prepare(
    "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind("rs_a", "wcus-2026", "WCUS 2026", "WCUS", "https://example.test", T)
    .run();
  await env.DB.prepare(
    "INSERT INTO import_runs (id, roster_source_id, format, status, expected_total, next_offset, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind("ir_a", "rs_a", "csv", "committed", 1, 1, T, T)
    .run();
  await env.DB.prepare(
    "INSERT INTO roster_entries (id, roster_source_id, external_row_key, content_hash, full_name, organization, source_url, source_captured_at, raw_record, last_seen_run_id, committed_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind("re_1", "rs_a", "row-1", "sha256:x", "Grace Hopper", "Navy", "https://example.test", T, "{}", "ir_a", "ir_a", T, T)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM tags").run();
});

describe("searchPeople", () => {
  it("finds only durable people, never staged roster entries", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    await seedRoster();

    const out = await searchPeople(ctx, { query: "Hopper" });
    // `contacts` would collide with add_contact / person_contacts / PersonDetail.contacts.
    expect(out.people).toEqual([]);
    expect(out).not.toHaveProperty("roster_entries");
  });

  it("returns organization and tags inline so a second call is rarely needed", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const out = await searchPeople(ctx, { query: "Lovelace" });
    expect(out.people[0]).toEqual(
      expect.objectContaining({ organization: "Kinsta", tags: ["wcus"] })
    );
  });

  it("excludes archived people unless asked", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    await env.DB.prepare("UPDATE people SET archived_at = ? WHERE id = ?").bind(T, person.id).run();

    expect((await searchPeople(ctx, { query: "Lovelace" })).people).toEqual([]);
    expect(
      (await searchPeople(ctx, { query: "Lovelace", include_archived: true })).people
    ).toHaveLength(1);
  });

  it("treats a query containing FTS operators as literal text", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace" });
    // Must not throw a malformed-MATCH error.
    const out = await searchPeople(ctx, { query: 'Lovelace" OR "' });
    expect(Array.isArray(out.people)).toBe(true);
  });

  it("rejects an empty query", async () => {
    await expect(searchPeople(ctx, { query: "   " })).rejects.toThrow(ToolError);
  });

  it("falls back to prefix matching on a partial word", async () => {
    // "Lov" is not a token, so a bare FTS5 MATCH finds nothing. The spec requires
    // a prefix fallback here, because an agent typing a partial name is normal.
    await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    const out = await searchPeople(ctx, { query: "Lov" });
    expect(out.people).toHaveLength(1);
    expect(out.people[0]?.full_name).toBe("Ada Lovelace");
  });

  it("does not prefix-match a long query that already found nothing", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace" });
    const out = await searchPeople(ctx, { query: "Kubernetes" });
    expect(out.people).toEqual([]);
  });

  it("finds a person by a tag that appears nowhere in their text", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const out = await searchPeople(ctx, { query: "wcus" });
    expect(out.people).toHaveLength(1);
    expect(out.people[0]?.id).toBe(person.id);
  });

  it("ranks a text match above a tag-only match", async () => {
    const tagged = await createPerson(ctx, { full_name: "Ada Lovelace" });
    await addTags(ctx, { person_id: tagged.id, tags: ["kinsta"] });
    await createPerson(ctx, { full_name: "Grace Hopper", organization: "Kinsta" });

    const out = await searchPeople(ctx, { query: "Kinsta" });
    expect(out.people.map((r) => r.full_name)).toEqual(["Grace Hopper", "Ada Lovelace"]);
  });

  it("answers who-is-this-email through person_contacts", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "Ada@Example.TEST",
    });
    // Matched on normalized_value, which is why Task 1 indexes that column.
    const out = await searchPeople(ctx, { query: "ada@example.test" });
    expect(out.people[0]?.id).toBe(person.id);
  });

  it("pages the people array with a cursor rather than a truncated flag", async () => {
    for (let i = 0; i < 30; i++) {
      await createPerson(ctx, { full_name: `Tester Kinsta ${i}`, force: true });
    }
    const first = await searchPeople(ctx, { query: "Kinsta", limit: 10 });
    expect(first.people).toHaveLength(10);
    expect(first.next_cursor).toBeTruthy();

    const second = await searchPeople(ctx, {
      query: "Kinsta",
      limit: 10,
      cursor: first.next_cursor!,
    });
    expect(second.people).toHaveLength(10);
    const overlap = second.people.filter((p) => first.people.some((q) => q.id === p.id));
    expect(overlap).toEqual([]);
  });

  it("KEEPS PREFIX MATCHING on page two", async () => {
    // The page-two hole. Without the mode in the cursor, page one falls back to
    // prefix, returns a full page and a cursor, and page two runs the exact
    // query, finds nothing, and reports an empty page after promising more.
    for (let i = 0; i < 25; i++) {
      await createPerson(ctx, { full_name: `Lovelace Number ${i}`, force: true });
    }

    const first = await searchPeople(ctx, { query: "Lov", limit: 20 });
    expect(first.people).toHaveLength(20);
    expect(first.next_cursor).toBeTruthy();

    const second = await searchPeople(ctx, {
      query: "Lov",
      limit: 20,
      cursor: first.next_cursor!,
    });
    expect(second.people.length).toBeGreaterThan(0);

    const seen = new Set([...first.people, ...second.people].map((p) => p.id));
    expect(seen.size).toBe(25);
  });

  it("returns a null cursor on the last page", async () => {
    await createPerson(ctx, { full_name: "Ada Kinsta" });
    const out = await searchPeople(ctx, { query: "Kinsta", limit: 10 });
    expect(out.next_cursor).toBeNull();
  });

  it("throws limit_exceeded above the maximum rather than clamping", async () => {
    try {
      await searchPeople(ctx, { query: "Kinsta", limit: 500 });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("limit_exceeded");
    }
  });

  it("rejects a cursor this server did not issue", async () => {
    try {
      await searchPeople(ctx, { query: "Kinsta", cursor: "garbage" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_input");
    }
  });

  it("rejects a cursor issued by a different tool rather than silently resetting", async () => {
    await seedRoster();
    for (let i = 0; i < 15; i++) {
      await env.DB.prepare(
        "INSERT INTO roster_entries (id, roster_source_id, external_row_key, content_hash, full_name, organization, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(`re_c_${i}`, "rs_a", `row-c-${i}`, "sha256:x", `Hopper Cross ${i}`, null, "https://example.test", T, "{}", "ir_a", T, T)
        .run();
    }
    const rosterPage = await searchRosterEntries(ctx, { query: "Hopper Cross", limit: 10 });
    expect(rosterPage.next_cursor).toBeTruthy();
    try {
      await searchPeople(ctx, { query: "Kinsta", cursor: rosterPage.next_cursor! });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_input");
    }
  });
});

describe("searchPeople after the split", () => {
  it("returns one array and no roster results", async () => {
    const result = await searchPeople(ctx, { query: "a" });
    expect(result).not.toHaveProperty("roster_entries");
    expect(result).not.toHaveProperty("people_next_cursor");
    expect(result).toHaveProperty("next_cursor");
  });
});
