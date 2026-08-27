import { describe, expect, it, vi } from "vitest";
import { exportArchive } from "./export.mjs";
import { BACKED_UP } from "./lib/inventory.mjs";
import { verifyManifest } from "./lib/manifest.mjs";

const runner = () =>
  vi.fn(async (args) => {
    const sql = args[args.indexOf("--command") + 1];
    if (sql.includes("UNION ALL")) {
      const rows = BACKED_UP.map((t) => ({ t, n: t === "people" ? 1 : 0 }));
      return JSON.stringify([{ success: true, meta: {}, results: rows }]);
    }
    const table = sql.replace("SELECT * FROM ", "");
    const rows = table === "people" ? [{ id: "p_1", full_name: "Ada" }] : [];
    return JSON.stringify([{ success: true, meta: {}, results: rows }]);
  });

describe("exportArchive", () => {
  // Asserting the call count alone would pass if the same table were read
  // eleven times. Assert the actual set of tables.
  it("reads every table in the inventory, once each", async () => {
    const run = runner();
    await exportArchive({ database: "junco-prm", run, now: () => new Date("2026-08-27T12:00:00Z") });
    const selected = run.mock.calls
      .map((c) => c[0][c[0].indexOf("--command") + 1])
      .filter((sql) => sql.startsWith("SELECT * FROM "))
      .map((sql) => sql.replace("SELECT * FROM ", ""));
    expect([...selected].sort()).toEqual([...BACKED_UP].sort());
  });

  it("produces an archive that verifies against its own manifest", async () => {
    const archive = await exportArchive({
      database: "junco-prm",
      run: runner(),
      now: () => new Date("2026-08-27T12:00:00Z"),
    });
    expect(verifyManifest(archive)).toEqual({ ok: true, problems: [] });
  });

  // The failure this exists to catch: a query that silently returns fewer
  // rows than the table holds. Without the independent count, every check in
  // this plan endorses the short archive, because they all derive from it.
  it("aborts when a table read returns fewer rows than the database reports", async () => {
    const run = vi.fn(async (args) => {
      const sql = args[args.indexOf("--command") + 1];
      if (sql.includes("UNION ALL")) {
        // The count query: people really holds 2 rows.
        const rows = BACKED_UP.map((t) => ({ t, n: t === "people" ? 2 : 0 }));
        return JSON.stringify([{ success: true, meta: {}, results: rows }]);
      }
      const table = sql.replace("SELECT * FROM ", "");
      const rows = table === "people" ? [{ id: "p_1", full_name: "Ada" }] : [];
      return JSON.stringify([{ success: true, meta: {}, results: rows }]);
    });
    await expect(
      exportArchive({ database: "junco-prm", run, now: () => new Date() })
    ).rejects.toThrow(/people.*read 1.*reports 2/);
  });

  // The failure that matters: one table read fails, and the archive is
  // written anyway with that table empty. It must abort instead.
  it("aborts rather than writing an archive with a table that failed to read", async () => {
    const run = vi.fn(async (args) => {
      const sql = args[args.indexOf("--command") + 1];
      if (sql.includes("encounters")) return "Authentication error\n";
      return JSON.stringify([{ success: true, meta: {}, results: [] }]);
    });
    await expect(
      exportArchive({ database: "junco-prm", run, now: () => new Date() })
    ).rejects.toThrow(/encounters/);
  });
});
