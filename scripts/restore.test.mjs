import { describe, expect, it } from "vitest";
import { insertStatements, MAX_STATEMENT_BYTES } from "./restore.mjs";

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
