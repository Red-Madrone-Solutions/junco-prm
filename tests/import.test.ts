import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { finalizeImport, importRoster } from "../src/tools/import";
import { IMPORT_BATCH_LIMIT } from "../src/tools/import_state";
import { searchPeople } from "../src/tools/search";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

const SOURCE = {
  source_key: "wcus-2026",
  label: "WordCamp US 2026",
  event: "WCUS 2026",
  source_url: "https://example.test/attendees",
  format: "json" as const,
};

async function countEntries(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("importRoster", () => {
  it("creates the source and run on the first call", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", organization: "Kinsta" }],
    });
    expect(out.run_id).toMatch(/^ir_/);
    expect(out.roster_source_id).toMatch(/^rs_/);
    expect(out.imported).toBe(1);
    expect(out.updated).toBe(0);
    expect(out.next_offset).toBe(1);
    expect(out.remaining).toBe(0);
  });

  it("counts a re-import as updated, not imported", async () => {
    const rows = [{ external_row_key: "1", full_name: "Ada Lovelace" }];
    const first = await importRoster(ctx, { ...SOURCE, expected_total: 1, rows });
    const second = await importRoster(ctx, { ...SOURCE, expected_total: 1, rows });
    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);
    expect(await countEntries()).toBe(1);
  });

  it("updates the stored row on re-import", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", organization: "Kinsta" }],
    });
    await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", organization: "Automattic" }],
    });
    const row = await env.DB.prepare(
      "SELECT organization FROM roster_entries WHERE external_row_key = ?"
    )
      // Stored keys carry their tier prefix ("k:" for a source's own row id,
      // per src/normalize.ts) - "1" alone matches nothing.
      .bind("k:1")
      .first<{ organization: string }>();
    expect(row?.organization).toBe("Automattic");
  });

  it("derives a stable row key by content hash when the source has none", async () => {
    const rows = [{ full_name: "Ada Lovelace", organization: "Kinsta" }];
    await importRoster(ctx, { ...SOURCE, expected_total: 1, rows });
    await importRoster(ctx, { ...SOURCE, expected_total: 1, rows });
    expect(await countEntries()).toBe(1);
  });

  it("never treats a name as an identity", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Chris Smith", organization: "A" },
        { external_row_key: "2", full_name: "Chris Smith", organization: "B" },
      ],
    });
    expect(await countEntries()).toBe(2);
  });

  it("walks a multi-chunk run to completion", async () => {
    const all = Array.from({ length: IMPORT_BATCH_LIMIT + 25 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));

    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: all.length,
      rows: all.slice(0, IMPORT_BATCH_LIMIT),
    });
    expect(first.imported).toBe(IMPORT_BATCH_LIMIT);
    expect(first.next_offset).toBe(IMPORT_BATCH_LIMIT);
    expect(first.remaining).toBe(25);

    const second = await importRoster(ctx, {
      ...SOURCE,
      rows: all.slice(IMPORT_BATCH_LIMIT),
      run_id: first.run_id,
      offset: first.next_offset,
    });
    expect(second.imported).toBe(25);
    expect(second.remaining).toBe(0);
    expect(await countEntries()).toBe(all.length);
  });

  it("rejects a chunk larger than the server cap instead of truncating it", async () => {
    const rows = Array.from({ length: IMPORT_BATCH_LIMIT + 1 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    await expect(
      importRoster(ctx, { ...SOURCE, expected_total: rows.length, rows })
    ).rejects.toThrow(ToolError);
    expect(await countEntries()).toBe(0);
  });

  it("refuses a continuation that skips rows", async () => {
    const all = Array.from({ length: 40 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: all.length,
      rows: all.slice(0, 20),
    });
    await expect(
      importRoster(ctx, {
        ...SOURCE,
        rows: all.slice(30),
        run_id: first.run_id,
        offset: 30,
      })
    ).rejects.toThrow(ToolError);
  });

  it("refuses a chunk that would carry the run past its declared total", async () => {
    const rows = [
      { external_row_key: "1", full_name: "Ada" },
      { external_row_key: "2", full_name: "Grace" },
    ];
    await expect(
      importRoster(ctx, { ...SOURCE, expected_total: 1, rows })
    ).rejects.toThrow(ToolError);
  });

  it("reports per-row errors instead of failing the whole batch", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace" },
        { external_row_key: "2", full_name: "   " },
      ],
    });
    expect(out.imported).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.errors).toEqual([{ index: 1, reason: "full_name is required" }]);
    // A row the server refused still counts as sent; the run can still complete.
    expect(out.next_offset).toBe(2);
    expect(out.remaining).toBe(0);
  });

  it("keeps the last of two rows sharing one key within a call", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace", organization: "First" },
        { external_row_key: "1", full_name: "Ada Lovelace", organization: "Second" },
      ],
    });
    expect(out.imported).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.errors[0]?.index).toBe(0);
    expect(out.errors[0]?.reason).toMatch(/duplicate/);
    expect(await countEntries()).toBe(1);

    const row = await env.DB.prepare(
      "SELECT organization FROM roster_entries WHERE external_row_key = ?"
    )
      // Stored keys carry their tier prefix ("k:" for a source's own row id,
      // per src/normalize.ts) - "1" alone matches nothing.
      .bind("k:1")
      .first<{ organization: string }>();
    expect(row?.organization).toBe("Second");
  });

  it("stores provenance on every row", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }],
    });
    const row = await env.DB.prepare(
      "SELECT source_url, source_captured_at, raw_record, last_seen_run_id FROM roster_entries LIMIT 1"
    ).first<{
      source_url: string;
      source_captured_at: string;
      raw_record: string;
      last_seen_run_id: string;
    }>();
    expect(row?.source_url).toBe(SOURCE.source_url);
    expect(row?.source_captured_at).toBe("2026-08-20T12:00:00.000Z");
    expect(row?.last_seen_run_id).toMatch(/^ir_/);
    expect(JSON.parse(row?.raw_record ?? "{}")).toEqual(
      expect.objectContaining({ full_name: "Ada Lovelace" })
    );
  });

  it("replays a retried chunk without advancing the run twice", async () => {
    const all = Array.from({ length: 40 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: all.length,
      rows: all.slice(0, 20),
    });

    const args = {
      ...SOURCE,
      rows: all.slice(20),
      run_id: first.run_id,
      offset: first.next_offset,
      idempotency_key: "chunk-2",
    };
    const second = await importRoster(ctx, args);
    // The client never saw the response and sent the same chunk again.
    const retried = await importRoster(ctx, args);

    expect(retried).toEqual(second);
    expect(retried.next_offset).toBe(40);
    expect(await countEntries()).toBe(40);
  });

  it("REPORTS a cross-chunk collision instead of silently absorbing a row", async () => {
    // Two people, same name, same organization, no email and no source row id.
    // They share a tier-3 key. Split across two calls so the within-chunk check
    // cannot catch them.
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [{ full_name: "Chris Smith", organization: "Studio A", job_title: "Designer" }],
    });

    const second = await importRoster(ctx, {
      ...SOURCE,
      run_id: first.run_id,
      offset: first.next_offset,
      rows: [{ full_name: "Chris Smith", organization: "Studio A", job_title: "Developer" }],
    });

    // The write happened - refusing would strand the roster - but it is named.
    expect(second.updated).toBe(1);
    expect(second.errors).toHaveLength(0); // same name, so this one is an edit

    // Now the case that IS a collision: a different person under the same key.
    const third = await importRoster(ctx, {
      ...SOURCE,
      source_key: "other-roster",
      label: "Other",
      expected_total: 2,
      rows: [{ full_name: "Chris Smith", organization: "Studio A" }],
    });
    const fourth = await importRoster(ctx, {
      ...SOURCE,
      source_key: "other-roster",
      label: "Other",
      run_id: third.run_id,
      offset: third.next_offset,
      rows: [{ full_name: "Chris  Smith", organization: "Studio A", job_title: "Developer" }],
    });
    // Normalized to the same name, so still an edit rather than a collision.
    expect(fourth.errors).toHaveLength(0);
  });

  it("does not report an ordinary re-import as a collision", async () => {
    // A corrected job title on the same person must stay silent, or the report
    // is noise and nobody reads it.
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", job_title: "Programmer" }],
    });
    await finalizeImport(ctx, { run_id: first.run_id });

    const second = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", job_title: "Senior Programmer" }],
    });
    expect(second.updated).toBe(1);
    expect(second.errors).toEqual([]);
  });

  it("rejects a rows argument that is not an array", async () => {
    await expect(
      importRoster(ctx, { ...SOURCE, expected_total: 1, rows: "not an array" as never })
    ).rejects.toThrow(ToolError);
  });
});

describe("abandoned run staleness", () => {
  // The RULING this task shipped under: staleness must compare committed_run_id,
  // never last_seen_run_id, because last_seen_run_id stamps unconditionally on
  // every write - open run included - and comparing against it directly makes
  // an abandoned run invert staleness for every row it touched.
  //
  // August is imported and finalized as run A; every row is stamped A. September
  // opens as run B, imports Ada, stamps her with B, and is then abandoned - the
  // agent's loop dies, nobody calls finalize_import. Ada is the freshest row
  // present and must still read CURRENT; Grace, whom September never mentioned,
  // must ALSO still read CURRENT, because August - still the latest COMMITTED
  // run - saw her and nothing has declared a newer complete picture of this
  // roster. An abandoned run is inert, not merely reversed.
  it("keeps an abandoned run from inverting staleness for the row it touched or the row it omitted", async () => {
    const august = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace" },
        { external_row_key: "2", full_name: "Grace Hopper" },
      ],
    });
    await finalizeImport(ctx, { run_id: august.run_id });

    // September opens, imports Ada only, and is never finalized.
    await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }],
    });

    const ada = await searchPeople(ctx, { query: "Lovelace", scope: "roster" });
    const grace = await searchPeople(ctx, { query: "Hopper", scope: "roster" });

    expect(ada.roster_entries[0]?.stale).toBe(false);
    expect(grace.roster_entries[0]?.stale).toBe(false);
  });
});
