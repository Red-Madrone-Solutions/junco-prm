import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";

export interface RosterListEntry {
  record_kind: "roster_entry";
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  role: string | null;
  source_key: string;
  external_row_key: string;
  /**
   * Non-null when durable provenance already exists for this row's
   * (source_key, external_row_key), the same join search_roster_entries uses.
   * It survives a purge and a re-import under the same source_key; a link to
   * the staged row itself would not.
   */
  promoted_person_id: string | null;
}

export interface ListRosterEntriesInput {
  source_key?: string;
  role?: string;
  organization?: string;
  promoted?: boolean;
  limit?: number;
  /** Pages the `roster_entries` array. Opaque; only src/paginate.ts may read it. */
  cursor?: string;
}

export interface ListRosterEntriesResult {
  roster_entries: RosterListEntry[];
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function listRosterEntries(
  ctx: ToolContext,
  input: ListRosterEntriesInput
): Promise<ListRosterEntriesResult> {
  const limit = clampLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const probe = limit + 1; // one extra row is how "is there a next page" is answered

  const decoded = decodeCursor(input.cursor) as
    | { kind?: string; full_name?: string; id?: string }
    | null;
  if (decoded !== null && decoded.kind !== "roster_list") {
    // A different kind from "roster_list" (search_roster_entries issues
    // "roster") means this cursor was minted by another tool. Silently
    // restarting at page 1 would hand back duplicate rows with nothing to
    // signal it, so this is refused the same way a garbage cursor already is.
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this server issued for the roster_entries array",
      "call the same tool again without a cursor to start from the first page"
    );
  }
  const after = decoded;

  const promotedParam = input.promoted === undefined ? null : input.promoted ? 1 : 0;

  // `promoted_person_id` joins DURABLE provenance on (source_key,
  // external_row_key), matching search_roster_entries. The `promoted` filter
  // is a separate EXISTS / NOT EXISTS test rather than comparing against the
  // SELECT-list subquery above, because SQLite cannot reference a SELECT-list
  // alias from WHERE. There is deliberately no index for either direction of
  // this filter, or for `role` alone without `source_key`; migrations/0009
  // records why.
  const { results: rows } = await ctx.db
    .prepare(
      `SELECT re.id AS id, re.full_name AS full_name, re.organization AS organization,
              re.job_title AS job_title, re.role AS role, rs.source_key AS source_key,
              re.external_row_key AS external_row_key,
              (SELECT ps.person_id FROM person_sources ps
                WHERE ps.source_key = rs.source_key
                  AND ps.external_row_key = re.external_row_key
                LIMIT 1) AS promoted_person_id
         FROM roster_entries re
         JOIN roster_sources rs ON rs.id = re.roster_source_id
        WHERE (?1 IS NULL OR rs.source_key = ?1)
          AND (?2 IS NULL OR re.role = ?2)
          AND (?3 IS NULL OR re.organization = ?3)
          AND (
            ?4 IS NULL
            OR (?4 = 1 AND EXISTS (SELECT 1 FROM person_sources ps
                                     WHERE ps.source_key = rs.source_key
                                       AND ps.external_row_key = re.external_row_key))
            OR (?4 = 0 AND NOT EXISTS (SELECT 1 FROM person_sources ps
                                         WHERE ps.source_key = rs.source_key
                                           AND ps.external_row_key = re.external_row_key))
          )
          AND (?5 IS NULL OR re.full_name > ?5 OR (re.full_name = ?5 AND re.id > ?6))
        ORDER BY re.full_name, re.id
        LIMIT ?7`
    )
    .bind(
      input.source_key ?? null,
      input.role ?? null,
      input.organization ?? null,
      promotedParam,
      after?.full_name ?? null,
      after?.id ?? null,
      probe
    )
    .all<{
      id: string;
      full_name: string;
      organization: string | null;
      job_title: string | null;
      role: string | null;
      source_key: string;
      external_row_key: string;
      promoted_person_id: string | null;
    }>();

  const page = rows.slice(0, limit);
  const roster_entries: RosterListEntry[] = page.map((r) => ({
    record_kind: "roster_entry" as const,
    ...r,
  }));

  let next_cursor: string | null = null;
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    next_cursor = encodeCursor({ kind: "roster_list", full_name: last.full_name, id: last.id });
  }

  return { roster_entries, next_cursor };
}
