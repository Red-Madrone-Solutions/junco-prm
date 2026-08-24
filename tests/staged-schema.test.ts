import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T = "2026-08-20T00:00:00Z";

async function seedSource(id = "rs_a", key = "wcus-2026"): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, key, "WordCamp US 2026", "WCUS 2026", "https://example.test/a", T)
    .run();
  return id;
}

async function seedRun(
  sourceId: string,
  id = "ir_a",
  status = "open",
  finishedAt: string | null = null
): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO import_runs (id, roster_source_id, format, status, expected_total, next_offset, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, sourceId, "csv", status, 1, 0, T, finishedAt)
    .run();
  return id;
}

function insertEntry(
  id: string,
  sourceId: string,
  key: string,
  runId: string,
  hash = "sha256:content-1",
  name = "Ada Lovelace"
) {
  return env.DB.prepare(
    "INSERT INTO roster_entries (id, roster_source_id, external_row_key, content_hash, full_name, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, sourceId, key, hash, name, "https://example.test/a", T, "{}", runId, T, T)
    .run();
}

describe("staged schema", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM roster_entries").run();
    await env.DB.prepare("DELETE FROM import_runs").run();
    await env.DB.prepare("DELETE FROM roster_sources").run();
    await env.DB.prepare("DELETE FROM people").run();
  });

  it("rejects a duplicate external row key within one source", async () => {
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    await insertEntry("re_1", sourceId, "row-7", runId);
    await expect(insertEntry("re_2", sourceId, "row-7", runId)).rejects.toThrow();
  });

  it("allows the same external row key under a different source", async () => {
    const a = await seedSource("rs_a", "wcus-2026");
    const runA = await seedRun(a, "ir_a");
    const b = await seedSource("rs_b", "wceu-2026");
    const runB = await seedRun(b, "ir_b");

    await insertEntry("re_1", a, "row-7", runA);
    await expect(insertEntry("re_2", b, "row-7", runB)).resolves.toBeTruthy();
  });

  it("lets a row's content_hash change while its identity key stays put", async () => {
    // The case the previous key design broke. A corrected job title arrives as
    // an UPDATE to one row, not as a second row beside a stale original.
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    await insertEntry("re_1", sourceId, "row-7", runId, "sha256:before");
    await env.DB.prepare(
      "UPDATE roster_entries SET content_hash = ?, job_title = ?, updated_at = ? WHERE roster_source_id = ? AND external_row_key = ?"
    )
      .bind("sha256:after", "Senior Programmer", T, sourceId, "row-7")
      .run();

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_entries WHERE roster_source_id = ?"
    )
      .bind(sourceId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const row = await env.DB.prepare(
      "SELECT content_hash, id FROM roster_entries WHERE roster_source_id = ? AND external_row_key = ?"
    )
      .bind(sourceId, "row-7")
      .first<{ content_hash: string; id: string }>();
    expect(row?.content_hash).toBe("sha256:after");
    expect(row?.id).toBe("re_1"); // same row, so provenance pointing at it survives
  });

  it("derives staleness from the source's latest completed run, with no column for it", async () => {
    // A row seen in August and absent from September is stale. Nothing writes a
    // flag; the fact falls out of last_seen_run_id against the latest completed
    // run. Task 14 and Task 9 both read it this way.
    const sourceId = await seedSource();
    const august = await seedRun(sourceId, "ir_aug", "committed", "2026-08-01T00:00:00Z");
    const september = await seedRun(sourceId, "ir_sep", "committed", "2026-09-01T00:00:00Z");

    await insertEntry("re_current", sourceId, "row-1", september);
    await insertEntry("re_stale", sourceId, "row-2", august);

    // THE SAME FORMULATION TASKS 9 AND 14 USE, verbatim. Two things about it
    // are load-bearing and neither is obvious.
    //
    // ROW_NUMBER, not `finished_at = (SELECT MAX(...))`. The MAX form returns
    // EVERY run tied on finished_at, and the LEFT JOIN then duplicates every
    // roster row. That is not hypothetical here: every test in this plan uses a
    // frozen clock, so two runs finalized in one test have byte-identical
    // timestamps. `id DESC` breaks the tie deterministically.
    //
    // CASE WHEN, not `<>`. A bare `<>` against an empty subquery yields SQL
    // NULL, so "no completed run" silently becomes three-valued logic instead
    // of the intended third state.
    const { results } = await env.DB.prepare(
      `WITH latest AS (
         SELECT roster_source_id, run_id FROM (
           SELECT roster_source_id, id AS run_id,
                  ROW_NUMBER() OVER (PARTITION BY roster_source_id
                                     ORDER BY finished_at DESC, id DESC) AS rn
             FROM import_runs WHERE status = 'committed'
         ) WHERE rn = 1
       )
       SELECT e.id,
              CASE WHEN l.run_id IS NULL THEN NULL
                   WHEN e.last_seen_run_id = l.run_id THEN 0
                   ELSE 1 END AS stale
         FROM roster_entries e
         LEFT JOIN latest l ON l.roster_source_id = e.roster_source_id
        WHERE e.roster_source_id = ?
        ORDER BY e.id`
    )
      .bind(sourceId)
      .all<{ id: string; stale: number }>();

    expect(results).toEqual([
      { id: "re_current", stale: 0 },
      { id: "re_stale", stale: 1 },
    ]);
  });

  it("returns ONE row per entry when two runs share a finished_at", async () => {
    // The defect this formulation exists to avoid. Every test in this plan uses
    // a frozen clock, so identical timestamps are the normal case here, not an
    // exotic one. Under `finished_at = (SELECT MAX(...))` both runs qualify and
    // the LEFT JOIN emits each roster entry twice - with different `stale`
    // values, since last_seen_run_id matches one run and not the other.
    const sourceId = await seedSource();
    const a = await seedRun(sourceId, "ir_a", "committed", "2026-09-01T00:00:00Z");
    await seedRun(sourceId, "ir_b", "committed", "2026-09-01T00:00:00Z");
    await insertEntry("re_1", sourceId, "row-1", a);

    const { results } = await env.DB.prepare(
      `WITH latest AS (
         SELECT roster_source_id, run_id FROM (
           SELECT roster_source_id, id AS run_id,
                  ROW_NUMBER() OVER (PARTITION BY roster_source_id
                                     ORDER BY finished_at DESC, id DESC) AS rn
             FROM import_runs WHERE status = 'committed'
         ) WHERE rn = 1
       )
       SELECT e.id FROM roster_entries e
         LEFT JOIN latest l ON l.roster_source_id = e.roster_source_id
        WHERE e.roster_source_id = ?`
    )
      .bind(sourceId)
      .all<{ id: string }>();

    expect(results).toHaveLength(1);
  });

  it("keeps a stale row selectable, because nothing deletes or hides it", async () => {
    const sourceId = await seedSource();
    const august = await seedRun(sourceId, "ir_aug", "committed", "2026-08-01T00:00:00Z");
    await seedRun(sourceId, "ir_sep", "committed", "2026-09-01T00:00:00Z");
    await insertEntry("re_stale", sourceId, "row-2", august);

    const row = await env.DB.prepare("SELECT id FROM roster_entries WHERE id = ?")
      .bind("re_stale")
      .first<{ id: string }>();
    expect(row?.id).toBe("re_stale");
  });

  it("refuses two people promoted from one roster row", async () => {
    // The unique constraint that replaces person_roster_entries. One roster row
    // is one human; two people promoted from it is a bug, not a tolerated
    // duplicate.
    for (const id of ["p_1", "p_2"]) {
      await env.DB.prepare(
        "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
        .bind(id, "Ada Lovelace", T, T)
        .run();
    }
    const insertProvenance = (id: string, personId: string) =>
      env.DB.prepare(
        "INSERT INTO person_sources (id, person_id, source_key, external_row_key, source_label, source_event, source_url, source_captured_at, raw_record_snapshot, content_hash_at_promotion, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, personId, "wcus-2026", "row-7", "WordCamp US 2026", "WCUS 2026", "https://example.test/a", T, "{}", "sha256:abc", T)
        .run();

    await insertProvenance("ps_1", "p_1");
    await expect(insertProvenance("ps_2", "p_2")).rejects.toThrow();
  });

  it("lets one person carry provenance from two different rosters", async () => {
    // The normal case for anyone who attends a conference twice. The pointer
    // pair this table replaced could not represent it at all.
    await env.DB.prepare(
      "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("p_1", "Ada Lovelace", T, T)
      .run();

    for (const [id, key] of [["ps_1", "wcus-2026"], ["ps_2", "wceu-2026"]]) {
      await env.DB.prepare(
        "INSERT INTO person_sources (id, person_id, source_key, external_row_key, source_label, source_event, source_url, source_captured_at, raw_record_snapshot, content_hash_at_promotion, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, "p_1", key, "row-7", "label", "event", "https://example.test", T, "{}", "sha256:abc", T)
        .run();
    }

    const { results } = await env.DB.prepare(
      "SELECT source_key FROM person_sources WHERE person_id = ? ORDER BY source_key"
    )
      .bind("p_1")
      .all<{ source_key: string }>();
    expect(results.map((r) => r.source_key)).toEqual(["wceu-2026", "wcus-2026"]);
  });

  it("keeps person provenance, snapshot included, after the staged rows are purged", async () => {
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    await env.DB.prepare(
      "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("p_1", "Ada Lovelace", T, T)
      .run();
    await insertEntry("re_1", sourceId, "row-7", runId);
    await env.DB.prepare(
      "INSERT INTO person_sources (id, person_id, source_key, external_row_key, source_label, source_event, source_url, source_captured_at, raw_record_snapshot, content_hash_at_promotion, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "ps_1", "p_1", "wcus-2026", "row-7", "WordCamp US 2026", "WCUS 2026",
        "https://example.test/a", T, '{"full_name":"Ada Lovelace"}', "sha256:abc", T
      )
      .run();

    // A purge deletes entries and stamps the source. It never deletes the source.
    await env.DB.prepare("DELETE FROM roster_entries WHERE roster_source_id = ?").bind(sourceId).run();
    await env.DB.prepare("UPDATE roster_sources SET purged_at = ? WHERE id = ?").bind(T, sourceId).run();

    const staged = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(staged?.n).toBe(0);

    const provenance = await env.DB.prepare(
      "SELECT source_key, raw_record_snapshot FROM person_sources WHERE person_id = ?"
    )
      .bind("p_1")
      .first<{ source_key: string; raw_record_snapshot: string }>();
    expect(provenance?.source_key).toBe("wcus-2026");
    // The snapshot is the whole argument for storing one. The hash alone would
    // be worthless now that the row it hashed no longer exists.
    expect(JSON.parse(provenance!.raw_record_snapshot)).toEqual({ full_name: "Ada Lovelace" });
  });

  it("survives a purge and a re-import under the same key without colliding", async () => {
    // The tombstone case. The source row is never deleted, so its key cannot be
    // recycled onto different data, and 2026 provenance cannot be returned as
    // evidence for a 2027 row.
    const sourceId = await seedSource();
    await env.DB.prepare("UPDATE roster_sources SET purged_at = ? WHERE id = ?").bind(T, sourceId).run();

    await expect(seedSource("rs_new", "wcus-2026")).rejects.toThrow();

    const surviving = await env.DB.prepare(
      "SELECT id, purged_at FROM roster_sources WHERE source_key = ?"
    )
      .bind("wcus-2026")
      .first<{ id: string; purged_at: string | null }>();
    expect(surviving?.id).toBe("rs_a");
    expect(surviving?.purged_at).toBe(T);
  });
});
