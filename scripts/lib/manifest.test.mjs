import { describe, expect, it } from "vitest";
import { BACKED_UP } from "./inventory.mjs";
import { buildManifest, checksum, verifyManifest } from "./manifest.mjs";

// Every table the inventory requires, not just the two under assertion, so
// this reads as a real untampered archive rather than one that is already
// short nine tables before any test starts tampering with it.
const archive = (overrides = {}) => {
  const tables = Object.fromEntries(BACKED_UP.map((name) => [name, []]));
  tables.people = [{ id: "p_1", full_name: "Ada" }];
  return {
    manifest: buildManifest({
      tables,
      schemaVersion: "0008_committed_run.sql",
      appVersion: "1.0.0",
      exportedAt: "2026-08-27T12:00:00.000Z",
    }),
    tables,
    ...overrides,
  };
};

describe("checksum", () => {
  // Fails if key order in a row changes the digest. wrangler's JSON output
  // has no ordering guarantee, so an order-sensitive checksum would report
  // corruption on a perfectly good archive.
  it("is stable across key order within a row", () => {
    expect(checksum([{ a: 1, b: 2 }])).toBe(checksum([{ b: 2, a: 1 }]));
  });

  // Fails if row order is ignored. Row order is real content: it is what a
  // restore replays, so two different orders are two different archives.
  it("changes when row order changes", () => {
    expect(checksum([{ id: 1 }, { id: 2 }])).not.toBe(checksum([{ id: 2 }, { id: 1 }]));
  });

  it("changes when a value changes", () => {
    expect(checksum([{ id: 1 }])).not.toBe(checksum([{ id: 2 }]));
  });

  it("distinguishes an empty table from a missing one", () => {
    expect(checksum([])).toHaveLength(64);
  });
});

describe("buildManifest", () => {
  it("records a count and a checksum for every table", () => {
    const m = archive().manifest;
    expect(m.tables.people).toEqual({ count: 1, checksum: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(m.tables.tags).toEqual({ count: 0, checksum: expect.any(String) });
  });

  // The manifest travels with the file and is read by someone who does not
  // have this repository open. What is absent has to be stated in the file.
  it("carries the exclusion reasons so the archive explains its own gaps", () => {
    const m = archive().manifest;
    expect(m.excluded.people_fts).toMatch(/derived/i);
    expect(m.excluded.idempotency_keys).toMatch(/operational/i);
  });

  it("carries the schema version, app version, and export time", () => {
    const m = archive().manifest;
    expect(m.schema_version).toBe("0008_committed_run.sql");
    expect(m.app_version).toBe("1.0.0");
    expect(m.exported_at).toBe("2026-08-27T12:00:00.000Z");
  });
});

describe("verifyManifest", () => {
  it("accepts an untampered archive", () => {
    expect(verifyManifest(archive())).toEqual({ ok: true, problems: [] });
  });

  // The failure this whole task exists to catch: a truncated file whose rows
  // were cut off but whose manifest still claims the original count.
  it("rejects an archive whose row count no longer matches", () => {
    const a = archive();
    a.tables.people = [];
    const result = verifyManifest(a);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/people.*count/i);
  });

  it("rejects an archive whose contents were altered without the count changing", () => {
    const a = archive();
    a.tables.people = [{ id: "p_1", full_name: "Grace" }];
    const result = verifyManifest(a);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/people.*checksum/i);
  });

  it("rejects an archive that is missing a table the manifest promises", () => {
    const a = archive();
    delete a.tables.tags;
    expect(verifyManifest(a).ok).toBe(false);
  });

  // THE ONE THAT MATTERS. The manifest is built from the payload, so it can
  // only ever describe what is present. Drop a table from both and every
  // check above still passes: export succeeds, verification says ok, restore
  // reports success, and every follow-up is gone with nothing said.
  // The archive has to be self-describing at recovery time, on a machine that
  // may not have this repository, so the inventory check belongs in the file.
  it("rejects an archive missing a table the inventory requires", () => {
    const a = archive();
    delete a.manifest.tables.tags;
    delete a.tables.tags;
    const result = verifyManifest(a);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/tags.*inventory/i);
  });

  it("rejects an archive carrying a table the inventory does not know", () => {
    const a = archive();
    a.manifest.tables.mystery = { count: 0, checksum: checksum([]) };
    a.tables.mystery = [];
    expect(verifyManifest(a).ok).toBe(false);
  });

  it("rejects an archive written by a future format version", () => {
    const a = archive();
    a.manifest.format_version = 99;
    expect(verifyManifest(a).ok).toBe(false);
  });
});
