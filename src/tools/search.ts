import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { normalizeEmail } from "../normalize";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";

/** `people`, not `contacts`: `contacts` already means emails and phone numbers. */
export type SearchScope = "people" | "roster" | "all";

const TAG_SEP = "\x1f";

export interface PersonHit {
  record_kind: "person";
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  archived_at: string | null;
  last_encounter_on: string | null;
  tags: string[];
}

export interface RosterHit {
  record_kind: "roster_entry";
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  source_key: string;
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

export interface SearchInput {
  query: string;
  scope?: SearchScope;
  include_archived?: boolean;
  limit?: number;
  /** Pages the `people` array. Opaque; only src/paginate.ts may read it. */
  people_cursor?: string;
  /** Pages the `roster_entries` array, independently of the one above. */
  roster_cursor?: string;
}

export interface SearchResult {
  scope: SearchScope;
  people: PersonHit[];
  roster_entries: RosterHit[];
  people_next_cursor: string | null;
  roster_next_cursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const PREFIX_MAX_TERM_LENGTH = 5;

export function toMatchQuery(raw: string, prefix = false): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t !== "")
    .map((t) => (prefix ? `"${t}"*` : `"${t}"`))
    .join(" ");
}

/**
 * A short query is one whose longest term is short enough that the user is
 * plausibly typing a partial word. Only those get a second, prefix-matched
 * attempt, so a genuine miss on a long query stays a miss rather than
 * fuzzily matching something unrelated.
 */
export function isShortQuery(raw: string): boolean {
  const terms = raw.trim().split(/\s+/).filter((t) => t !== "");
  return terms.length > 0 && terms.every((t) => t.length <= PREFIX_MAX_TERM_LENGTH);
}

interface PersonRow {
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  archived_at: string | null;
  last_encounter_on: string | null;
  tag_blob: string | null;
  /** The bm25 score this row sorted on. Carried out so it can go in a cursor. */
  rank: number;
}

/**
 * Escapes the LIKE metacharacters so a query containing % or _ matches those
 * characters literally instead of behaving as a wildcard. Pairs with ESCAPE
 * in every LIKE clause below.
 */
export function likePattern(raw: string): string {
  return `%${raw.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * `after` is the decoded people cursor, or null for the first page.
 *
 * The keyset is `(rank, id)` rather than an offset, because an offset over a
 * ranked search re-runs the whole query and re-ranks it on every page, so a row
 * written between two pages shifts everything and the caller silently skips or
 * repeats a record. `id` breaks ties, since bm25 scores collide readily on
 * short documents.
 */
async function matchPeople(
  ctx: ToolContext,
  match: string,
  input: SearchInput,
  probe: number,
  after: { rank?: number | string; id?: string | number } | null
): Promise<PersonRow[]> {
  if (match === "") return [];
  const { results } = await ctx.db
    .prepare(
      `WITH text_hits AS (
         SELECT f.id AS id, bm25(people_fts) AS rank
         FROM people_fts f
         WHERE people_fts MATCH ?1
       ),
       tag_hits AS (
         SELECT pt.person_id AS id, 1000.0 AS rank
         FROM person_tags pt
         JOIN tags t ON t.id = pt.tag_id
         WHERE t.name LIKE ?4 ESCAPE '\\'
       ),
       contact_hits AS (
         SELECT c.person_id AS id, 500.0 AS rank
         FROM person_contacts c
         WHERE c.normalized_value = ?7
       ),
       hits AS (
         SELECT id, MIN(rank) AS rank
         FROM (SELECT id, rank FROM text_hits
               UNION ALL SELECT id, rank FROM tag_hits
               UNION ALL SELECT id, rank FROM contact_hits)
         GROUP BY id
       )
       SELECT p.id AS id, p.full_name AS full_name, p.organization AS organization,
              p.job_title AS job_title, p.archived_at AS archived_at,
              hits.rank AS rank,
              (SELECT MAX(occurred_on) FROM encounters e
                WHERE e.person_id = p.id) AS last_encounter_on,
              (SELECT group_concat(t.name, char(31)) FROM person_tags pt
                 JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = p.id) AS tag_blob
       FROM hits
       JOIN people p ON p.id = hits.id
       WHERE (?2 = 1 OR p.archived_at IS NULL)
         AND (?5 IS NULL
              OR hits.rank > ?5
              OR (hits.rank = ?5 AND p.id > ?6))
       ORDER BY hits.rank, p.id
       LIMIT ?3`
    )
    .bind(
      match,
      input.include_archived ? 1 : 0,
      probe,
      likePattern(input.query),
      after?.rank ?? null,
      after?.id ?? null,
      // "who is bob@example.test" - matched on the normalized column Task 1
      // indexes for exactly this and for create_person's duplicate check.
      normalizeEmail(input.query)
    )
    .all<PersonRow>();
  return results;
}

// `contact_hits` scores 500 rather than 1000 so an exact email match outranks a
// tag match but not a strong text match. It is a fixed score because bm25 has
// no meaning for a non-FTS source, and mixing a real relevance score with two
// constants is already a compromise; the alternative, a separate ranked query
// per source merged in TypeScript, buys precision this system does not need at
// a few thousand rows.

export async function searchPeople(
  ctx: ToolContext,
  input: SearchInput
): Promise<SearchResult> {
  if (typeof input.query !== "string" || input.query.trim() === "") {
    throw new ToolError("invalid_input", "query is required and must be a non-empty string");
  }
  const scope: SearchScope = input.scope ?? "people";
  if (scope !== "people" && scope !== "roster" && scope !== "all") {
    throw new ToolError("invalid_input", 'scope must be "people", "roster", or "all"');
  }

  // clampLimit throws limit_exceeded above the maximum rather than clamping
  // silently, so an agent asking for 500 is told it cannot have them.
  const limit = clampLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const probe = limit + 1; // one extra row is how "is there a next page" is answered

  const people: PersonHit[] = [];
  const roster_entries: RosterHit[] = [];
  let people_next_cursor: string | null = null;
  let roster_next_cursor: string | null = null;

  if (scope === "people" || scope === "all") {
    const decoded = decodeCursor(input.people_cursor) as
      | { kind?: string; rank?: number; id?: string; prefix?: number }
      | null;
    if (decoded !== null && decoded.kind !== "people") {
      // A cursor decodes fine but carries the WRONG ARRAY's keyset - most
      // likely a roster cursor pasted into this field. Silently restarting at
      // page 1 would hand back duplicate rows with nothing to signal it, so
      // this is refused the same way a garbage cursor already is.
      throw new ToolError(
        "invalid_input",
        "people_cursor is not a token this server issued for the people array",
        "call the same tool again without a cursor to start from the first page"
      );
    }
    const after = decoded === null ? null : { ...decoded, prefix: decoded.prefix === 1 };

    // THE QUERY MODE IS DECIDED ONCE AND CARRIED IN THE CURSOR.
    //
    // The previous draft ran the prefix fallback only when `after === null`,
    // which made it unreachable on page two. Search "Lov" against 25 matching
    // people with limit 20: page one finds nothing exact, falls back to prefix,
    // returns 20 rows AND a cursor. Page two presents that cursor, the fallback
    // is skipped, the exact query returns nothing, and the caller gets an empty
    // page having just been told there was more. Five people vanish silently.
    let usePrefix = after?.prefix === true;
    let rows = usePrefix
      ? await matchPeople(ctx, toMatchQuery(input.query, true), input, probe, after)
      : await matchPeople(ctx, toMatchQuery(input.query), input, probe, after);

    if (rows.length === 0 && !usePrefix && after === null && isShortQuery(input.query)) {
      usePrefix = true;
      rows = await matchPeople(ctx, toMatchQuery(input.query, true), input, probe, null);
    }

    const page = rows.slice(0, limit);
    for (const r of page) {
      people.push({
        record_kind: "person",
        id: r.id,
        full_name: r.full_name,
        organization: r.organization,
        job_title: r.job_title,
        archived_at: r.archived_at,
        last_encounter_on: r.last_encounter_on,
        tags: r.tag_blob ? r.tag_blob.split(TAG_SEP) : [],
      });
    }
    if (rows.length > limit) {
      const last = page[page.length - 1]!;
      // `prefix` travels with the position, so page two searches the same way
      // page one did.
      people_next_cursor = encodeCursor(
        usePrefix
          ? { kind: "people", rank: last.rank, id: last.id, prefix: 1 }
          : { kind: "people", rank: last.rank, id: last.id }
      );
    }
  }

  if (scope === "roster" || scope === "all") {
    const decodedRoster = decodeCursor(input.roster_cursor) as
      | { kind?: string; full_name?: string; id?: string }
      | null;
    if (decodedRoster !== null && decodedRoster.kind !== "roster") {
      // Mirrors the people_cursor check above: a decodable cursor from the
      // wrong array must not be treated as page 1 with no signal.
      throw new ToolError(
        "invalid_input",
        "roster_cursor is not a token this server issued for the roster_entries array",
        "call the same tool again without a cursor to start from the first page"
      );
    }
    const after = decodedRoster;
    const like = likePattern(input.query);

    // Three things happen in this one statement, and each replaces something
    // the previous draft got wrong:
    //
    // `promoted_person_id` joins DURABLE provenance on (source_key,
    // external_row_key) rather than reading a `person_roster_entries` row. That
    // join survives a purge and a re-import a year later; a link to a staged
    // row does not.
    //
    // `stale` is DERIVED from last_seen_run_id against the source's latest
    // completed run. No column stores it, because a caller assertion cannot
    // gate a destructive operation and so nothing is allowed to write one.
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
        `WITH latest AS (
           -- EXACTLY ONE ROW PER SOURCE. See the note below on why the obvious
           -- formulation is wrong.
           SELECT roster_source_id, run_id, finished_at FROM (
             SELECT roster_source_id, id AS run_id, finished_at,
                    ROW_NUMBER() OVER (PARTITION BY roster_source_id
                                       ORDER BY finished_at DESC, id DESC) AS rn
               FROM import_runs WHERE status = 'committed'
           ) WHERE rn = 1
         )
         SELECT re.id AS id, re.full_name AS full_name, re.organization AS organization,
                re.job_title AS job_title, rs.source_key AS source_key,
                (SELECT ps.person_id FROM person_sources ps
                  WHERE ps.source_key = rs.source_key
                    AND ps.external_row_key = re.external_row_key
                  LIMIT 1) AS promoted_person_id,
                CASE WHEN l.run_id IS NULL THEN NULL
                     WHEN re.last_seen_run_id = l.run_id THEN 0
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
        promoted_person_id: r.promoted_person_id,
        stale: r.stale === null ? null : r.stale === 1,
        source_last_imported_at: r.source_last_imported_at,
      });
    }
    if (rows.length > limit) {
      const last = page[page.length - 1]!;
      roster_next_cursor = encodeCursor({ kind: "roster", full_name: last.full_name, id: last.id });
    }
  }

  // `raw_record` is selected by neither branch. It is untrusted text and this
  // result goes straight into a model's context, often immediately before a
  // write against one of these records.
  return { scope, people, roster_entries, people_next_cursor, roster_next_cursor };
}
