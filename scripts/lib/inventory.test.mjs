import { describe, expect, it } from "vitest";
import { ALL_KNOWN, BACKED_UP, EXCLUDED, tablesInMigrations } from "./inventory.mjs";

describe("the table inventory", () => {
  // THE POINT OF THIS FILE. Fails when a migration adds a table and nobody
  // decides whether it belongs in the archive. Without this, the archive
  // silently stops being complete and nothing says so.
  it("classifies every table the migrations create", async () => {
    const actual = await tablesInMigrations("./migrations");
    expect([...actual].sort()).toEqual([...ALL_KNOWN].sort());
  });

  // Fails if a table is both backed up and excluded, which would mean the
  // reason string is a lie.
  it("never both backs up and excludes the same table", () => {
    const overlap = BACKED_UP.filter((t) => t in EXCLUDED);
    expect(overlap).toEqual([]);
  });

  // Fails if a parent is restored after its child. Restoring person_contacts
  // before people violates the foreign key and the restore aborts partway,
  // which is the worst moment to discover an ordering mistake.
  it("orders parents before their children", () => {
    const pos = (t) => BACKED_UP.indexOf(t);
    expect(pos("people")).toBeLessThan(pos("person_contacts"));
    expect(pos("people")).toBeLessThan(pos("person_links"));
    expect(pos("people")).toBeLessThan(pos("person_tags"));
    expect(pos("tags")).toBeLessThan(pos("person_tags"));
    expect(pos("people")).toBeLessThan(pos("encounters"));
    expect(pos("people")).toBeLessThan(pos("followups"));
    expect(pos("roster_sources")).toBeLessThan(pos("import_runs"));
    expect(pos("roster_sources")).toBeLessThan(pos("roster_entries"));
    // Two real foreign keys, both easy to miss: roster_entries.last_seen_run_id
    // is NOT NULL REFERENCES import_runs(id) (migration 0002), and
    // committed_run_id references it too (migration 0008).
    expect(pos("import_runs")).toBeLessThan(pos("roster_entries"));
    expect(pos("people")).toBeLessThan(pos("person_sources"));
    expect(pos("roster_sources")).toBeLessThan(pos("person_sources"));
  });

  // Fails if an FTS5 table reaches the archive. Reading one produces the
  // index's internal shadow rows, not records, and restoring that is how a
  // backup comes back corrupt.
  it("excludes both FTS5 virtual tables with a stated reason", () => {
    expect(EXCLUDED.people_fts).toMatch(/derived/i);
    expect(EXCLUDED.encounters_fts).toMatch(/derived/i);
    expect(BACKED_UP).not.toContain("people_fts");
    expect(BACKED_UP).not.toContain("encounters_fts");
  });
});
