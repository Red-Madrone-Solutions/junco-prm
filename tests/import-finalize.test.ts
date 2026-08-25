import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { finalizeImport, importRoster } from "../src/tools/import";
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

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("finalizeImport", () => {
  it("marks the run committed and stamps finished_at", async () => {
    const run = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const out = await finalizeImport(ctx, { run_id: run.run_id });
    expect(out.status).toBe("committed");

    const row = await env.DB.prepare(
      "SELECT status, finished_at FROM import_runs WHERE id = ?"
    )
      .bind(run.run_id)
      .first<{ status: string; finished_at: string | null }>();
    expect(row?.status).toBe("committed");
    expect(row?.finished_at).toBe("2026-08-20T12:00:00.000Z");
  });

  it("DELETES NOTHING when a later run omits a row", async () => {
    // The case the removed retirement mechanism existed to handle, and the case
    // it got wrong. A row absent from September is annotated, never destroyed.
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id });

    const second = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const out = await finalizeImport(ctx, { run_id: second.run_id });

    expect(out.total_entries).toBe(2);
    expect(out.current).toBe(1);
    expect(out.stale).toBe(1);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it("leaves the omitted row searchable and promotable", async () => {
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace" },
        { external_row_key: "2", full_name: "Grace Hopper" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id });

    const second = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }],
    });
    await finalizeImport(ctx, { run_id: second.run_id });

    // A person who left the attendee list is still someone you met.
    const found = await searchPeople(ctx, { query: "Hopper", scope: "roster" });
    expect(found.roster_entries).toHaveLength(1);
    expect(found.roster_entries[0]?.stale).toBe(true);
  });

  it("a TRUNCATED input destroys nothing, which is the whole reason retirement is gone", async () => {
    // An agent whose page lazy-loaded 1 of 2 rows declares the total it can see
    // and satisfies every check that could be written. Under the previous
    // design this call retired a current row. It must now be inert.
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id });

    const truncated = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1, // honestly declared, and wrong about the world
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    await finalizeImport(ctx, { run_id: truncated.run_id });

    const grace = await env.DB.prepare(
      "SELECT full_name FROM roster_entries WHERE external_row_key = ?"
    )
      .bind("k:2")
      .first<{ full_name: string }>();
    expect(grace?.full_name).toBe("Grace");
  });

  it("an UNFINALIZED import does not invert staleness", async () => {
    // VERIFY BEFORE FIXING. One reviewer of four claimed this is broken and the
    // other three did not look; this test decides it rather than reasoning
    // about it, which is how the STRONG_MATCH arithmetic bug survived.
    //
    // The claim: importRoster stamps last_seen_run_id with the OPEN run
    // immediately, so once September has imported Ada but never finalized -
    //   - Ada points at September, which is not the latest COMMITTED run, so
    //     she reads as stale;
    //   - Grace, whom September never sent, still points at August, which IS
    //     the latest committed run, so she reads as current.
    // Exactly backwards, and permanent if September is abandoned.
    //
    // If this test FAILS, the claim is right and the fix is a design decision:
    // either stamp last_seen_run_id only at finalization (needs chunk
    // membership recorded during import) or carry pending and committed
    // observation columns separately. Do not paper over it in the query.
    //
    // If it PASSES, the reviewer was wrong and this test stays as the record.
    const august = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace" },
        { external_row_key: "2", full_name: "Grace Hopper" },
      ],
    });
    await finalizeImport(ctx, { run_id: august.run_id });

    // September imports Ada only, and is never finalized.
    await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }],
    });

    const ada = await searchPeople(ctx, { query: "Lovelace", scope: "roster" });
    const grace = await searchPeople(ctx, { query: "Hopper", scope: "roster" });

    // Neither is stale. August is still the latest committed run and it saw
    // both rows; an open run is inert and must not change what either reads as.
    expect(ada.roster_entries[0]?.stale).toBe(false);
    expect(grace.roster_entries[0]?.stale).toBe(false);
  });

  it("does not become the staleness baseline until it is finalized", async () => {
    const first = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace" },
        { external_row_key: "2", full_name: "Grace Hopper" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id });

    // A second run that is started but never finalized.
    await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }],
    });

    // An abandoned run is inert. Grace is not stale, because nothing has
    // declared a newer complete picture of this roster.
    const found = await searchPeople(ctx, { query: "Hopper", scope: "roster" });
    expect(found.roster_entries[0]?.stale).toBe(false);
  });

  it("finalizes a run that has not reached its expected_total", async () => {
    // There is no longer a destructive action for the count to gate, so a run
    // that sent fewer rows than it declared is finalized like any other. The
    // worst a wrong expected_total can now do is make `remaining` misleading.
    const run = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 500,
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const out = await finalizeImport(ctx, { run_id: run.run_id });
    expect(out.status).toBe("committed");
    expect(out.total_entries).toBe(1);
  });

  it("counts promoted entries separately", async () => {
    const run = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 2,
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    await env.DB.prepare(
      "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("p_1", "Ada", "2026-08-20T12:00:00.000Z", "2026-08-20T12:00:00.000Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO person_sources (id, person_id, source_key, external_row_key, source_label, source_event, source_url, source_captured_at, raw_record_snapshot, content_hash_at_promotion, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("ps_1", "p_1", "wcus-2026", "k:1", "WordCamp US 2026", "WCUS 2026",
            "https://example.test/attendees", "2026-08-20T12:00:00.000Z", "{}", "sha256:x",
            "2026-08-20T12:00:00.000Z")
      .run();

    const out = await finalizeImport(ctx, { run_id: run.run_id });
    expect(out.promoted).toBe(1);
  });

  it("rejects an unknown run id", async () => {
    await expect(finalizeImport(ctx, { run_id: "ir_nope" })).rejects.toThrow(ToolError);
  });

  it("rejects a person id where a run id belongs", async () => {
    try {
      await finalizeImport(ctx, { run_id: "p_1" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_id");
    }
  });

  it("is idempotent: finalizing twice is not an error and does not move finished_at", async () => {
    const run = await importRoster(ctx, {
      ...SOURCE,
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const first = await finalizeImport(ctx, { run_id: run.run_id });
    const second = await finalizeImport(ctx, { run_id: run.run_id });
    expect(second).toEqual(first);

    const row = await env.DB.prepare("SELECT finished_at FROM import_runs WHERE id = ?")
      .bind(run.run_id)
      .first<{ finished_at: string }>();
    expect(row?.finished_at).toBe("2026-08-20T12:00:00.000Z");
  });
});
