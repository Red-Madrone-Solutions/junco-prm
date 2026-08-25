import { mintConfirmation, redeemConfirmation } from "../confirm";
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";

export interface RosterSourceSummary {
  id: string;
  record_kind: "roster_source";
  source_key: string;
  label: string;
  event: string | null;
  url: string | null;
  entry_count: number;
  /** Rows the latest completed run saw. */
  current_count: number;
  /** Rows it did not. Annotated, never acted on. */
  stale_count: number;
  promoted_count: number;
  /** When the latest COMPLETED run finished. Null if none ever has. */
  last_imported_at: string | null;
  /**
   * Set when the source's entries have been purged. The row itself is never
   * deleted, so this key can never be recycled onto different data.
   */
  purged_at: string | null;
}

/**
 * "818 current, 40 not seen since the August run, 12 promoted."
 *
 * `last_imported_at` is the latest COMPLETED run's finish time, not the latest
 * run's start time. Reading MAX(started_at) over every run would report an
 * abandoned run as the last import and make a roster look fresher than it is -
 * in the one tool whose job includes telling an agent that a roster is old
 * enough to suggest purging.
 *
 * Returns `{ sources: [...] }`, not a bare array.
 *
 * The registry's `envelope` wrapper adds `today` to an object result and wraps
 * a non-object as `{ result, today }`. An array is not an object for that
 * purpose, so a bare array would make this the ONE tool answering
 * `{ result: [...], today }` while every other returns its fields at the top
 * level - an inconsistency with no output schema to catch it and nothing
 * documenting it.
 */
export async function listRosterSources(
  ctx: ToolContext
): Promise<{ sources: RosterSourceSummary[] }> {
  const { results } = await ctx.db
    .prepare(
      `WITH latest AS (
         -- EXACTLY ONE ROW PER SOURCE. The tiebreak is rowid DESC, not id DESC:
         -- import_runs.id is "ir_" followed by crypto.randomUUID(), so ordering
         -- by it breaks a finished_at tie by comparing two random UUIDs. See
         -- the identical CTE in src/tools/search.ts.
         SELECT roster_source_id, run_id, finished_at FROM (
           SELECT roster_source_id, id AS run_id, finished_at,
                  ROW_NUMBER() OVER (PARTITION BY roster_source_id
                                     ORDER BY finished_at DESC, rowid DESC) AS rn
             FROM import_runs WHERE status = 'committed'
         ) WHERE rn = 1
       )
       SELECT rs.id AS id, rs.source_key AS source_key, rs.label AS label,
              rs.event AS event, rs.url AS url, rs.purged_at AS purged_at,
              (SELECT COUNT(*) FROM roster_entries re
                WHERE re.roster_source_id = rs.id) AS entry_count,
              (SELECT COUNT(*) FROM roster_entries re
                WHERE re.roster_source_id = rs.id
                  AND l.run_id IS NOT NULL
                  AND re.committed_run_id = l.run_id) AS current_count,
              (SELECT COUNT(*) FROM roster_entries re
                WHERE re.roster_source_id = rs.id
                  AND l.run_id IS NOT NULL
                  AND (re.committed_run_id IS NULL
                    OR re.committed_run_id <> l.run_id)) AS stale_count,
              (SELECT COUNT(*) FROM roster_entries re
                WHERE re.roster_source_id = rs.id
                  AND EXISTS (SELECT 1 FROM person_sources ps
                               WHERE ps.source_key = rs.source_key
                                 AND ps.external_row_key = re.external_row_key)) AS promoted_count,
              l.finished_at AS last_imported_at
         FROM roster_sources rs
         LEFT JOIN latest l ON l.roster_source_id = rs.id
        ORDER BY rs.created_at DESC, rs.id DESC`
    )
    .all<Omit<RosterSourceSummary, "record_kind">>();

  return { sources: results.map((row) => ({ record_kind: "roster_source" as const, ...row })) };
}

export interface RosterEntryDetail {
  record_kind: "roster_entry";
  id: string;
  source_key: string;
  source_label: string;
  source_event: string | null;
  external_row_key: string;
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  organization: string | null;
  email: string | null;
  role: string | null;
  source_url: string;
  source_captured_at: string;
  /** True when the latest completed run did not see this row. Null if none has. */
  stale: boolean | null;
  source_last_imported_at: string | null;
  /** Non-null when durable provenance already exists for this row. */
  promoted_person_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One staged row by its `re_` id.
 *
 * It does NOT return `raw_record`. It is untrusted text written by strangers
 * and fetched from the public web, and this result goes into a model's context
 * next to a promote decision. The stored `content_hash` is not returned either:
 * it is an internal change-detection value, `promote_roster_entry` hands out
 * the one the caller needs, and a hash in a read result invites an agent to
 * invent a use for it.
 */
export async function getRosterEntry(
  ctx: ToolContext,
  input: { roster_entry_id: string }
): Promise<RosterEntryDetail> {
  const id = assertId("re", input.roster_entry_id);

  const row = await ctx.db
    .prepare(
      `WITH latest AS (
         SELECT roster_source_id, run_id, finished_at FROM (
           SELECT roster_source_id, id AS run_id, finished_at,
                  ROW_NUMBER() OVER (PARTITION BY roster_source_id
                                     ORDER BY finished_at DESC, rowid DESC) AS rn
             FROM import_runs WHERE status = 'committed'
         ) WHERE rn = 1
       )
       SELECT re.id AS id, rs.source_key AS source_key, rs.label AS source_label,
              rs.event AS source_event, re.external_row_key AS external_row_key,
              re.full_name AS full_name, re.preferred_name AS preferred_name,
              re.job_title AS job_title, re.organization AS organization,
              re.email AS email, re.role AS role, re.source_url AS source_url,
              re.source_captured_at AS source_captured_at,
              re.created_at AS created_at, re.updated_at AS updated_at,
              CASE WHEN l.run_id IS NULL THEN NULL
                   WHEN re.committed_run_id = l.run_id THEN 0
                   ELSE 1 END AS stale,
              l.finished_at AS source_last_imported_at,
              (SELECT ps.person_id FROM person_sources ps
                WHERE ps.source_key = rs.source_key
                  AND ps.external_row_key = re.external_row_key
                LIMIT 1) AS promoted_person_id
         FROM roster_entries re
         JOIN roster_sources rs ON rs.id = re.roster_source_id
         LEFT JOIN latest l ON l.roster_source_id = re.roster_source_id
        WHERE re.id = ?`
    )
    .bind(id)
    .first<Omit<RosterEntryDetail, "record_kind" | "stale"> & { stale: number | null }>();

  if (!row) {
    throw new ToolError(
      "not_found",
      `no roster entry with id ${id}`,
      "the roster it came from may have been purged; call list_roster_sources to see what is still staged"
    );
  }

  return {
    record_kind: "roster_entry",
    ...row,
    stale: row.stale === null ? null : row.stale === 1,
  };
}

export interface PurgePreview {
  roster_source_id: string;
  source_key: string;
  entry_count: number;
  /**
   * How many of these rows have already been promoted. Their people and their
   * copied provenance are untouched by a purge; this number is here so the
   * human reading the preview knows the purge is not undoing that work.
   */
  promoted_count: number;
  /** Already purged, if non-null. A second purge is a no-op. */
  purged_at: string | null;
}

export type PurgeResult =
  | { status: "confirmation_required"; confirmation_token: string; preview: PurgePreview }
  | { status: "purged"; purged: PurgePreview };

export interface PurgeRosterSourceInput {
  roster_source_id: string;
  confirmation_token?: string;
  idempotency_key?: string;
}

async function purgePreview(ctx: ToolContext, id: string): Promise<PurgePreview> {
  const row = await ctx.db
    .prepare(
      `SELECT rs.source_key AS source_key, rs.purged_at AS purged_at,
              (SELECT COUNT(*) FROM roster_entries re WHERE re.roster_source_id = rs.id) AS entry_count,
              (SELECT COUNT(*) FROM roster_entries re
                WHERE re.roster_source_id = rs.id
                  AND EXISTS (SELECT 1 FROM person_sources ps
                               WHERE ps.source_key = rs.source_key
                                 AND ps.external_row_key = re.external_row_key)) AS promoted_count
       FROM roster_sources rs WHERE rs.id = ?`
    )
    .bind(id)
    .first<{
      source_key: string;
      purged_at: string | null;
      entry_count: number;
      promoted_count: number;
    }>();

  if (!row) throw new ToolError("not_found", `no roster source with id ${id}`);
  return { roster_source_id: id, ...row };
}

export async function purgeRosterSource(
  ctx: ToolContext,
  input: PurgeRosterSourceInput
): Promise<PurgeResult> {
  const id = assertId("rs", input.roster_source_id);

  if (input.confirmation_token === undefined) {
    const preview = await purgePreview(ctx, id);
    const confirmation_token = await mintConfirmation(ctx, "purge_roster_source", id, preview);
    return { status: "confirmation_required", confirmation_token, preview };
  }

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "purge_roster_source", idempotency_key, rest, async () => {
    // Same ordering, and it matters more here: a preview reporting 0 entries
    // can otherwise authorize deleting a roster imported seconds later, having
    // shown the human that nothing would be lost.
    const preview = await purgePreview(ctx, id);
    await redeemConfirmation(ctx, "purge_roster_source", id, input.confirmation_token, preview);
    const at = nowIso(ctx.clock);

    // THE SOURCE ROW SURVIVES. Purging deletes its entries and stamps
    // `purged_at`; it never deletes the source itself.
    //
    // If source keys could be recycled, an agent that purges `wcus-attendees`
    // and later imports the 2027 roster under the same obvious key would
    // produce (source_key, external_row_key) collisions against 2026
    // provenance, and promote_roster_entry would return a 2026 person as its
    // strongest evidence for a 2027 row. That is a silent write against the
    // wrong person, which the spec names as its most likely real failure.
    //
    // Both statements in one batch: a source stamped purged whose entries are
    // still there, or entries deleted with no tombstone, are each worse than
    // either failing outright.
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM roster_entries WHERE roster_source_id = ?").bind(id),
      ctx.db
        .prepare("UPDATE roster_sources SET purged_at = ? WHERE id = ? AND purged_at IS NULL")
        .bind(at, id),
    ]);

    return { status: "purged" as const, purged: { ...preview, purged_at: at } };
  });
}
