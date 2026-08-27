import { describe, expect, it, vi } from "vitest";
import { checkTargetEmpty, insertStatements, MAX_STATEMENT_BYTES } from "./restore.mjs";

describe("insertStatements", () => {
  it("emits an INSERT per row, in inventory order", () => {
    const sql = insertStatements({
      people: [{ id: "p_1", full_name: "Ada" }],
      tags: [{ id: "t_1", name: "speaker" }],
    });
    expect(sql.indexOf("INSERT INTO people")).toBeLessThan(sql.indexOf("INSERT INTO tags"));
  });

  // A single quote in a note is the most ordinary content imaginable, and an
  // unescaped one turns a restore into a syntax error at best.
  it("escapes single quotes in values", () => {
    const sql = insertStatements({ people: [{ id: "p_1", full_name: "O'Brien" }] });
    expect(sql).toContain("'O''Brien'");
  });

  it("writes NULL for null values rather than the string null", () => {
    const sql = insertStatements({ people: [{ id: "p_1", organization: null }] });
    expect(sql).toMatch(/VALUES\s*\('p_1',\s*NULL\)/);
  });

  it("writes numbers unquoted", () => {
    const sql = insertStatements({ people: [{ id: "p_1", rank: 3 }] });
    expect(sql).toMatch(/'p_1',\s*3/);
  });

  // FTS5 tables must never be written directly. Their content arrives via the
  // triggers when the source rows are inserted.
  it("never emits a statement against an FTS table", () => {
    const sql = insertStatements({ people: [{ id: "p_1" }] });
    expect(sql).not.toContain("people_fts");
    expect(sql).not.toContain("encounters_fts");
  });

  it("skips tables that are not in the inventory", () => {
    const sql = insertStatements({ people: [{ id: "p_1" }], idempotency_keys: [{ id: "x" }] });
    expect(sql).not.toContain("idempotency_keys");
  });

  // The failure this prevents is the nastiest one available: a row that
  // exports cleanly and cannot be restored, discovered during a recovery.
  // Whether D1's 100 KB statement limit reaches the import path is disputed,
  // so this refuses to find out the hard way.
  it("refuses to generate a statement over the size ceiling", () => {
    const huge = { id: "re_1", raw_record: "x".repeat(MAX_STATEMENT_BYTES + 1) };
    expect(() => insertStatements({ roster_entries: [huge] })).toThrow(/re_1.*ceiling|ceiling.*re_1/s);
  });

  it("allows a row comfortably under the ceiling", () => {
    const ok = { id: "re_2", raw_record: "x".repeat(1000) };
    expect(() => insertStatements({ roster_entries: [ok] })).not.toThrow();
  });
});

// Fake `run` that answers each successive wrangler invocation with the next
// entry in `responses`, in call order: first the sqlite_master count, then
// one countRows batch per call only when the count is above zero.
function fakeRun(responses) {
  let call = 0;
  return vi.fn(async () => {
    const response = responses[call];
    call += 1;
    if (response === undefined) throw new Error("unexpected extra wrangler call");
    return response;
  });
}

const success = (results) => JSON.stringify([{ success: true, results }]);
const failure = (error) => JSON.stringify([{ success: false, error }]);

describe("checkTargetEmpty", () => {
  it("treats a target with no Junco tables at all as empty", async () => {
    const run = fakeRun([success([{ n: 0 }])]);
    const status = await checkTargetEmpty({ database: "test-db", run });
    expect(status).toEqual({ empty: true, occupied: [] });
  });

  it("treats a fully migrated target with zero rows everywhere as empty", async () => {
    const run = fakeRun([
      success([{ n: 11 }]),
      success([
        { t: "people", n: 0 },
        { t: "tags", n: 0 },
        { t: "person_contacts", n: 0 },
        { t: "person_links", n: 0 },
        { t: "person_tags", n: 0 },
      ]),
      success([
        { t: "encounters", n: 0 },
        { t: "followups", n: 0 },
        { t: "roster_sources", n: 0 },
        { t: "import_runs", n: 0 },
        { t: "roster_entries", n: 0 },
      ]),
      success([{ t: "person_sources", n: 0 }]),
    ]);
    const status = await checkTargetEmpty({ database: "test-db", run });
    expect(status.empty).toBe(true);
  });

  it("refuses a fully migrated target that already holds rows", async () => {
    const run = fakeRun([
      success([{ n: 11 }]),
      success([
        { t: "people", n: 3 },
        { t: "tags", n: 0 },
        { t: "person_contacts", n: 0 },
        { t: "person_links", n: 0 },
        { t: "person_tags", n: 0 },
      ]),
      success([
        { t: "encounters", n: 0 },
        { t: "followups", n: 0 },
        { t: "roster_sources", n: 0 },
        { t: "import_runs", n: 0 },
        { t: "roster_entries", n: 0 },
      ]),
      success([{ t: "person_sources", n: 0 }]),
    ]);
    const status = await checkTargetEmpty({ database: "test-db", run });
    expect(status.empty).toBe(false);
    expect(status.occupied).toEqual([{ t: "people", n: 3 }]);
  });

  // The bug this guards against: some tables exist and already hold rows,
  // and a later table was never created (a drill database left behind by a
  // previous failed attempt is exactly this shape). The old guard read the
  // resulting "no such table" as proof the whole target was empty. This must
  // be refused, not treated as empty, so the error has to propagate.
  it("propagates a countRows error rather than treating a partially migrated target as empty", async () => {
    const run = fakeRun([
      success([{ n: 5 }]),
      success([
        { t: "people", n: 3 },
        { t: "tags", n: 0 },
        { t: "person_contacts", n: 0 },
        { t: "person_links", n: 0 },
        { t: "person_tags", n: 0 },
      ]),
      failure("D1_ERROR: no such table: encounters: SQLITE_ERROR"),
    ]);
    await expect(checkTargetEmpty({ database: "test-db", run })).rejects.toThrow(/no such table/i);
  });
});
