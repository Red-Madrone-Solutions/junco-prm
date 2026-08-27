import { describe, expect, it, vi } from "vitest";
import { parseExecuteJson, readTable } from "./d1.mjs";

// Recorded from a real `wrangler d1 execute --json` run. See docs/MEASUREMENTS.md.
const WRANGLER_OUTPUT = JSON.stringify([
  {
    success: true,
    meta: { duration: 1.2, rows_read: 2, rows_written: 0 },
    results: [
      { id: "p_1", full_name: "Ada Lovelace" },
      { id: "p_2", full_name: "Grace Hopper" },
    ],
  },
]);

describe("parseExecuteJson", () => {
  it("returns the rows", () => {
    expect(parseExecuteJson(WRANGLER_OUTPUT)).toEqual([
      { id: "p_1", full_name: "Ada Lovelace" },
      { id: "p_2", full_name: "Grace Hopper" },
    ]);
  });

  it("returns an empty array for an empty result set", () => {
    const empty = JSON.stringify([{ success: true, meta: {}, results: [] }]);
    expect(parseExecuteJson(empty)).toEqual([]);
  });

  // wrangler prints progress lines before the JSON. Parsing the whole stdout
  // with JSON.parse throws on those, and the failure would look like a
  // corrupt database rather than a chatty CLI.
  it("ignores anything printed before the JSON", () => {
    const noisy = `Proxying to remote database\n Executed 1 command\n${WRANGLER_OUTPUT}`;
    expect(parseExecuteJson(noisy)).toHaveLength(2);
  });

  // The noise above contains no brackets, so it passes even against a naive
  // indexOf("["). This one does not. wrangler prints exactly this banner when
  // a newer version exists, and the day it does, backups stop.
  it("ignores a bracketed warning banner before the JSON", () => {
    const noisy = `[WARNING] Wrangler is out of date, please update\n${WRANGLER_OUTPUT}`;
    expect(parseExecuteJson(noisy)).toHaveLength(2);
  });

  // Silence must never read as an empty table. An empty array here would let
  // the export record "0 rows" for a table that simply failed to be read.
  it("throws rather than returning empty when there is no JSON at all", () => {
    expect(() => parseExecuteJson("Authentication error\n")).toThrow(/no JSON/i);
  });

  it("throws when wrangler reports the statement did not succeed", () => {
    const failed = JSON.stringify([{ success: false, error: "no such table: nope" }]);
    expect(() => parseExecuteJson(failed)).toThrow(/no such table/);
  });
});

describe("readTable", () => {
  it("selects everything from the named table against the remote database", async () => {
    const run = vi.fn().mockResolvedValue(WRANGLER_OUTPUT);
    const rows = await readTable("people", { database: "junco-prm", remote: true, run });
    expect(rows).toHaveLength(2);
    const args = run.mock.calls[0][0];
    expect(args).toContain("--remote");
    expect(args).toContain("--json");
    expect(args.join(" ")).toContain("SELECT * FROM people");
  });

  // A table name reaching a SQL string unchecked is an injection point, and
  // this one is interpolated because SQLite cannot bind an identifier.
  it("refuses a table name that is not a plain identifier", async () => {
    const run = vi.fn();
    await expect(
      readTable("people; DROP TABLE people", { database: "junco-prm", run })
    ).rejects.toThrow(/table name/i);
    expect(run).not.toHaveBeenCalled();
  });
});
