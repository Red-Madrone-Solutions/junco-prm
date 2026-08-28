import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";
import { LATEST_COMMITTED_RUN_CTE } from "./latest_run";
import { likePattern } from "./search";

export interface RosterHit {
  record_kind: "roster_entry";
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  source_key: string;
  external_row_key: string;
  /**
   * Non-null when durable provenance already exists for this row's
   * (source_key, external_row_key). Without it the two arrays would contain the
   * same human twice with nothing connecting them, and an agent would spend a
   * promotion call to discover it.
   */
  promoted_person_id: string | null;
  /**
   * True when this row was not seen by the source's latest COMPLETED run.
   * A stale row is annotated and never acted on: it stays searchable and
   * promotable, because a person who left the attendee list is still someone
   * you met. Null when the source has no completed run to measure against.
   */
  stale: boolean | null;
  /** When that latest completed run finished, so "stale" has a date on it. */
  source_last_imported_at: string | null;
}

export interface SearchRosterInput {
  query: string;
  limit?: number;
  /** Pages the `roster_entries` array. Opaque; only src/paginate.ts may read it. */
  cursor?: string;
}

export interface SearchRosterResult {
  roster_entries: RosterHit[];
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function searchRosterEntries(
  ctx: ToolContext,
  input: SearchRosterInput
): Promise<SearchRosterResult> {
  if (typeof input.query !== "string" || input.query.trim() === "") {
    throw new ToolError("invalid_input", "query is required and must be a non-empty string");
  }

  // clampLimit throws limit_exceeded above the maximum rather than clamping
  // silently, so an agent asking for 500 is told it cannot have them.
  const limit = clampLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const probe = limit + 1; // one extra row is how "is there a next page" is answered

  const roster_entries: RosterHit[] = [];
  let next_cursor: string | null = null;

  const decoded = decodeCursor(input.cursor) as
    | { kind?: string; full_name?: string; id?: string }
    | null;
  if (decoded !== null && decoded.kind !== "roster") {
    // A cursor decodes fine but carries the WRONG ARRAY's keyset - most
    // likely a cursor issued by a different tool. Silently restarting at
    // page 1 would hand back duplicate rows with nothing to signal it, so
    // this is refused the same way a garbage cursor already is.
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this server issued for the roster_entries array",
      "call the same tool again without a cursor to start from the first page"
    );
  }
  const after = decoded;
  const like = likePattern(input.query);

  // Three things happen in this one statement, and each replaces something
  // the previous draft got wrong:
  //
  // `promoted_person_id` joins DURABLE provenance on (source_key,
  // external_row_key) rather than reading a `person_roster_entries` row. That
  // join survives a purge and a re-import a year later; a link to a staged
  // row does not.
  //
  // `stale` is DERIVED from committed_run_id against the source's latest
  // completed run - never from last_seen_run_id, which stamps unconditionally
  // on every write, open run included, and so would flip a row stale the
  // instant an abandoned run touched it. committed_run_id only ever moves
  // when finalize_import promotes it, so an abandoned run cannot reach this
  // comparison at all. See migrations/0008. No column stores `stale` itself,
  // because a caller assertion cannot gate a destructive operation and so
  // nothing is allowed to write one.
  //
  // The WHERE clause has no `retired_at IS NULL`. Nothing is ever retired, and
  // a stale row stays searchable on purpose.
  //
  // This is a FULL SCAN of roster_entries for the matching source(s), not an
  // index lookup: a leading-wildcard LIKE ('%term%') cannot use
  // idx_roster_entries_name or idx_roster_entries_email, or any other btree
  // index, because the leading '%' rules out a prefix seek. That is accepted
  // here - staged rows are disposable and few enough that the scan is
  // sub-millisecond - and migrations/0002 already names expression indexes as
  // the fix if that ever stops being true.
  const { results: rows } = await ctx.db
    .prepare(
      `WITH ${LATEST_COMMITTED_RUN_CTE}
       SELECT re.id AS id, re.full_name AS full_name, re.organization AS organization,
              re.job_title AS job_title, rs.source_key AS source_key,
              re.external_row_key AS external_row_key,
              (SELECT ps.person_id FROM person_sources ps
                WHERE ps.source_key = rs.source_key
                  AND ps.external_row_key = re.external_row_key
                LIMIT 1) AS promoted_person_id,
              CASE WHEN l.run_id IS NULL THEN NULL
                   WHEN re.committed_run_id = l.run_id THEN 0
                   ELSE 1 END AS stale,
              l.finished_at AS source_last_imported_at
         FROM roster_entries re
         JOIN roster_sources rs ON rs.id = re.roster_source_id
         LEFT JOIN latest l ON l.roster_source_id = re.roster_source_id
        WHERE (re.full_name LIKE ?1 ESCAPE '\\'
            OR re.organization LIKE ?1 ESCAPE '\\'
            OR re.job_title LIKE ?1 ESCAPE '\\')
          AND (?3 IS NULL OR re.full_name > ?3 OR (re.full_name = ?3 AND re.id > ?4))
        ORDER BY re.full_name, re.id
        LIMIT ?2`
    )
    .bind(like, probe, after?.full_name ?? null, after?.id ?? null)
    .all<{
      id: string;
      full_name: string;
      organization: string | null;
      job_title: string | null;
      source_key: string;
      external_row_key: string;
      promoted_person_id: string | null;
      stale: number | null;
      source_last_imported_at: string | null;
    }>();

  const page = rows.slice(0, limit);
  for (const r of page) {
    roster_entries.push({
      record_kind: "roster_entry",
      id: r.id,
      full_name: r.full_name,
      organization: r.organization,
      job_title: r.job_title,
      source_key: r.source_key,
      external_row_key: r.external_row_key,
      promoted_person_id: r.promoted_person_id,
      stale: r.stale === null ? null : r.stale === 1,
      source_last_imported_at: r.source_last_imported_at,
    });
  }
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    next_cursor = encodeCursor({ kind: "roster", full_name: last.full_name, id: last.id });
  }

  // `raw_record` is selected by neither branch. It is untrusted text and this
  // result goes straight into a model's context, often immediately before a
  // write against one of these records.
  return { roster_entries, next_cursor };
}
