import { describe, expect, it, vi } from "vitest";
import {
  checkTargetEmpty,
  insertStatements,
  loadIntoTarget,
  MAX_STATEMENT_BYTES,
  staleArchiveMessage,
} from "./restore.mjs";
import { BACKED_UP } from "./lib/inventory.mjs";

const zeroCounts = () => Object.fromEntries(BACKED_UP.map((t) => [t, 0]));
const zeroManifest = () => Object.fromEntries(BACKED_UP.map((t) => [t, { count: 0 }]));

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

  // A semicolon or a newline inside a note is ordinary content, not a
  // statement separator: it sits inside a quoted string literal, so it must
  // not split or corrupt the generated SQL.
  it("preserves a semicolon and a newline inside a quoted value", () => {
    const sql = insertStatements({ people: [{ id: "p_1", notes: "line one;\nline two" }] });
    expect(sql).toContain("'line one;\nline two'");
    expect(sql.match(/INSERT INTO/g)).toHaveLength(1);
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

// The concrete failure this explains: a migration adds a table (say
// `reminders`), the inventory grows to require it, and restoring an archive
// taken before that migration then fails verifyManifest with "reminders:
// required by the inventory, absent from this archive" - true, but useless
// to an operator mid-recovery who has no idea a migration is the reason.
describe("staleArchiveMessage", () => {
  it("returns null when the archive matches the newest migration on disk", () => {
    const message = staleArchiveMessage({
      archiveVersion: "0008_committed_run.sql",
      migrationsOnDisk: ["0001_durable_core.sql", "0008_committed_run.sql"],
    });
    expect(message).toBeNull();
  });

  it("returns null when the archive is newer than anything on disk", () => {
    const message = staleArchiveMessage({
      archiveVersion: "0009_reminders.sql",
      migrationsOnDisk: ["0001_durable_core.sql", "0008_committed_run.sql"],
    });
    expect(message).toBeNull();
  });

  it("names the archive version, the newer version, and the remedy when the archive predates a migration on disk", () => {
    const message = staleArchiveMessage({
      archiveVersion: "0008_committed_run.sql",
      migrationsOnDisk: [
        "0001_durable_core.sql",
        "0008_committed_run.sql",
        "0009_reminders.sql",
      ],
    });
    expect(message).toMatch(/0008_committed_run\.sql/);
    expect(message).toMatch(/0009_reminders\.sql/);
    expect(message).toMatch(/check out the commit/i);
    expect(message).toMatch(/apply the later migrations/i);
  });
});

// The safety property that matters is the ORDER: an occupied target must be
// refused before migrations ever run against it. An earlier version applied
// migrations first, which meant a mistyped database name got Junco's schema
// created in it before the script decided to refuse.
describe("loadIntoTarget", () => {
  it("checks emptiness before applying migrations, and applies migrations before loading rows", async () => {
    const calls = [];
    const actual = { ...zeroCounts(), people: 1 };
    const result = await loadIntoTarget({
      database: "test-db",
      sql: "INSERT INTO people (id) VALUES ('p_1');",
      manifestTables: { ...zeroManifest(), people: { count: 1 } },
      checkTargetEmpty: async () => {
        calls.push("checkTargetEmpty");
        return { empty: true, occupied: [] };
      },
      applyMigrations: async () => {
        calls.push("applyMigrations");
      },
      loadRows: async () => {
        calls.push("loadRows");
      },
      countRows: async () => {
        calls.push("countRows");
        return actual;
      },
    });

    expect(calls).toEqual(["checkTargetEmpty", "applyMigrations", "loadRows", "countRows"]);
    expect(result).toEqual({ ok: true, actual });
  });

  it("refuses an occupied target without ever calling applyMigrations or loadRows", async () => {
    const applyMigrations = vi.fn();
    const loadRows = vi.fn();
    const result = await loadIntoTarget({
      database: "test-db",
      sql: "",
      manifestTables: {},
      checkTargetEmpty: async () => ({ empty: false, occupied: [{ t: "people", n: 3 }] }),
      applyMigrations,
      loadRows,
      countRows: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "occupied",
      status: { empty: false, occupied: [{ t: "people", n: 3 }] },
    });
    expect(applyMigrations).not.toHaveBeenCalled();
    expect(loadRows).not.toHaveBeenCalled();
  });

  it("reports a count mismatch after loading rather than claiming success", async () => {
    const actual = { ...zeroCounts(), people: 3 };
    const result = await loadIntoTarget({
      database: "test-db",
      sql: "",
      manifestTables: { ...zeroManifest(), people: { count: 5 } },
      checkTargetEmpty: async () => ({ empty: true, occupied: [] }),
      applyMigrations: async () => {},
      loadRows: async () => {},
      countRows: async () => actual,
    });

    expect(result).toEqual({ ok: false, reason: "count-mismatch", actual, wrong: ["people"] });
  });
});
