import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { listRosterEntries } from "../src/tools/list_roster";
import { createPerson } from "../src/tools/people";
import { searchPeople } from "../src/tools/search";

const T = "2026-08-20T00:00:00Z";
const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date(T),
};

const SOURCE_KEY = "wcus-2026-attendees";

async function seedRosterSource(id: string, sourceKey: string) {
  await env.DB.prepare(
    "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, sourceKey, "WCUS 2026", "WCUS", "https://example.test", T)
    .run();
  await env.DB.prepare(
    "INSERT INTO import_runs (id, roster_source_id, format, status, expected_total, next_offset, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(`ir_${id}`, id, "csv", "committed", 1, 1, T, T)
    .run();
}

async function seedEntry(
  id: string,
  rosterSourceId: string,
  externalRowKey: string,
  fullName: string,
  opts: { role?: string | null; organization?: string | null } = {}
) {
  await env.DB.prepare(
    "INSERT INTO roster_entries (id, roster_source_id, external_row_key, content_hash, full_name, organization, role, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      id,
      rosterSourceId,
      externalRowKey,
      "sha256:x",
      fullName,
      opts.organization ?? null,
      opts.role ?? null,
      "https://example.test",
      T,
      "{}",
      `ir_${rosterSourceId}`,
      T,
      T
    )
    .run();
}

/** Durable provenance, staged the same way tests/search_roster.test.ts does. */
async function promoteEntry(sourceKey: string, externalRowKey: string, fullName: string, suffix: string) {
  const person = await createPerson(ctx, { full_name: fullName, force: true });
  await env.DB.prepare(
    "INSERT INTO person_sources (id, person_id, source_key, external_row_key, source_label, source_event, source_url, source_captured_at, raw_record_snapshot, content_hash_at_promotion, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      `ps_${suffix}`,
      person.id,
      sourceKey,
      externalRowKey,
      "WCUS 2026",
      "WCUS",
      "https://example.test",
      T,
      "{}",
      "sha256:x",
      T
    )
    .run();
  return person.id;
}

/**
 * 10 entries in one source: names sorted so the keyset order is predictable,
 * two speakers, two already promoted.
 */
async function seedRoster() {
  await seedRosterSource("rs_a", SOURCE_KEY);
  for (let i = 0; i < 10; i++) {
    const name = `Attendee ${String(i).padStart(2, "0")}`;
    const role = i === 2 || i === 6 ? "speaker" : "attendee";
    await seedEntry(`re_${i}`, "rs_a", `row-${i}`, name, { role, organization: "Navy" });
  }
  await promoteEntry(SOURCE_KEY, "row-1", "Attendee 01", "promo1");
  await promoteEntry(SOURCE_KEY, "row-4", "Attendee 04", "promo2");
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM roster_sources").run();
});

describe("listRosterEntries", () => {
  it("returns every entry for a source when no filter is given", async () => {
    await seedRoster();
    const result = await listRosterEntries(ctx, { source_key: SOURCE_KEY, limit: 5 });
    expect(result.roster_entries.length).toBeGreaterThan(0);
    expect(result.next_cursor).toBeTruthy();
  });

  // The blocked task this tool exists for: promote all speakers, without
  // knowing their names in advance.
  // .every() on an empty array is true, so a filter returning nothing passes.
  // Assert non-empty first, every time.
  it("filters by role", async () => {
    await seedRoster();
    const result = await listRosterEntries(ctx, { role: "speaker" });
    expect(result.roster_entries.length).toBeGreaterThan(0);
    expect(result.roster_entries.every((e) => e.role === "speaker")).toBe(true);
  });

  // The natural working queue, and currently unaskable.
  it("filters to entries not yet promoted", async () => {
    await seedRoster();
    const result = await listRosterEntries(ctx, { promoted: false, limit: 5 });
    expect(result.roster_entries.length).toBeGreaterThan(0);
    expect(result.roster_entries.every((e) => e.promoted_person_id === null)).toBe(true);
  });

  it("filters to entries already promoted", async () => {
    await seedRoster();
    const result = await listRosterEntries(ctx, { promoted: true, limit: 5 });
    expect(result.roster_entries.length).toBeGreaterThan(0);
    expect(result.roster_entries.every((e) => e.promoted_person_id !== null)).toBe(true);
  });

  it("returns external_row_key", async () => {
    await seedRoster();
    const result = await listRosterEntries(ctx, { limit: 1 });
    expect(result.roster_entries[0]).toHaveProperty("external_row_key");
  });

  // 759 unpromoted rows on the real roster, so paging is not optional and a
  // one-page test proves nothing about it.
  it("pages through more rows than one page holds without repeating", async () => {
    await seedRoster();
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

  it("matches organization exactly, including case", async () => {
    await seedRoster();
    const exact = await listRosterEntries(ctx, { organization: "Navy" });
    expect(exact.roster_entries.length).toBeGreaterThan(0);
    const wrongCase = await listRosterEntries(ctx, { organization: "navy" });
    expect(wrongCase.roster_entries).toEqual([]);
  });

  it("rejects a cursor this server did not issue", async () => {
    await expect(listRosterEntries(ctx, { cursor: "garbage" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a cursor issued by a different tool", async () => {
    for (let i = 0; i < 15; i++) {
      await createPerson(ctx, { full_name: `Tester Kinsta ${i}`, force: true });
    }
    const peoplePage = await searchPeople(ctx, { query: "Kinsta", limit: 5 });
    expect(peoplePage.next_cursor).toBeTruthy();
    await expect(
      listRosterEntries(ctx, { cursor: peoplePage.next_cursor ?? undefined })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
