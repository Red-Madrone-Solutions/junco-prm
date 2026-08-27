import { describe, expect, it, vi } from "vitest";
import { exportArchive, writeArchiveFile } from "./export.mjs";
import { BACKED_UP } from "./lib/inventory.mjs";
import { verifyManifest } from "./lib/manifest.mjs";
import { MAX_STATEMENT_BYTES } from "./lib/sql.mjs";

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

  // The comment on MAX_STATEMENT_BYTES promises this fails "at export or
  // drill time, instead of during a recovery." It only does if the export
  // actually calls insertStatements. Without this, an oversized row exports
  // cleanly, counts and checksums match, and the failure waits for a restore.
  it("aborts the export when a row would produce an oversized restore statement", async () => {
    const huge = "x".repeat(MAX_STATEMENT_BYTES);
    const run = vi.fn(async (args) => {
      const sql = args[args.indexOf("--command") + 1];
      if (sql.includes("UNION ALL")) {
        const rows = BACKED_UP.map((t) => ({ t, n: t === "roster_entries" ? 1 : 0 }));
        return JSON.stringify([{ success: true, meta: {}, results: rows }]);
      }
      const table = sql.replace("SELECT * FROM ", "");
      const rows = table === "roster_entries" ? [{ id: "re_1", raw_record: huge }] : [];
      return JSON.stringify([{ success: true, meta: {}, results: rows }]);
    });
    await expect(
      exportArchive({ database: "junco-prm", run, now: () => new Date() })
    ).rejects.toThrow(/re_1.*ceiling|ceiling.*re_1/s);
  });
});

// The safety property that matters is the ORDER: the trusted final name must
// never exist until compression AND its integrity check have both succeeded.
// An earlier version renamed the JSON into place and compressed it there, so
// an interrupted bzip2 left a truncated file under a trusted name.
describe("writeArchiveFile", () => {
  function fakeDeps(overrides = {}) {
    const calls = [];
    return {
      calls,
      writeFile: async () => { calls.push("writeFile"); },
      compress: async () => { calls.push("compress"); },
      verify: async () => { calls.push("verify"); },
      chmod: async () => { calls.push("chmod"); },
      rename: async () => { calls.push("rename"); },
      existsSync: () => false,
      unlink: async () => { calls.push("unlink"); },
      ...overrides,
    };
  }

  it("writes, compresses, verifies, then renames into the trusted final name, in that order", async () => {
    const deps = fakeDeps();
    await writeArchiveFile({
      archive: { tables: {} },
      jsonPath: "junco-backup-test.json",
      finalPath: "junco-backup-test.json.bz2",
      ...deps,
    });
    expect(deps.calls).toEqual(["writeFile", "compress", "verify", "chmod", "rename"]);
  });

  it("never renames into the final name when the integrity check fails", async () => {
    const rename = vi.fn();
    const deps = fakeDeps({
      verify: async () => { throw new Error("bzip2 -t failed"); },
      rename,
    });
    await expect(
      writeArchiveFile({
        archive: { tables: {} },
        jsonPath: "junco-backup-test.json",
        finalPath: "junco-backup-test.json.bz2",
        ...deps,
      })
    ).rejects.toThrow(/bzip2 -t failed/);
    expect(rename).not.toHaveBeenCalled();
  });

  // A bzip2 failure used to leave a plaintext .partial holding every contact
  // and note in the database. A same-minute retry then failed EEXIST with no
  // explanation of why or what to remove.
  it("cleans up the plaintext and compressed partials when compression or verification fails", async () => {
    const unlink = vi.fn(async () => {});
    const deps = fakeDeps({
      verify: async () => { throw new Error("bzip2 -t failed"); },
      unlink,
    });
    await expect(
      writeArchiveFile({
        archive: { tables: {} },
        jsonPath: "junco-backup-test.json",
        finalPath: "junco-backup-test.json.bz2",
        ...deps,
      })
    ).rejects.toThrow();
    expect(unlink).toHaveBeenCalledWith("junco-backup-test.json.partial");
    expect(unlink).toHaveBeenCalledWith("junco-backup-test.json.partial.bz2");
  });

  it("refuses to overwrite an existing archive", async () => {
    const rename = vi.fn();
    const deps = fakeDeps({ existsSync: () => true, rename });
    await expect(
      writeArchiveFile({
        archive: { tables: {} },
        jsonPath: "junco-backup-test.json",
        finalPath: "junco-backup-test.json.bz2",
        ...deps,
      })
    ).rejects.toThrow(/already exists/);
    expect(rename).not.toHaveBeenCalled();
  });
});
