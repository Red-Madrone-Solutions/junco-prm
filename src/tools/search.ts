import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { normalizeEmail } from "../normalize";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";

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

export interface SearchInput {
  query: string;
  include_archived?: boolean;
  limit?: number;
  /** Pages the `people` array. Opaque; only src/paginate.ts may read it. */
  cursor?: string;
}

export interface SearchResult {
  people: PersonHit[];
  next_cursor: string | null;
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

  // clampLimit throws limit_exceeded above the maximum rather than clamping
  // silently, so an agent asking for 500 is told it cannot have them.
  const limit = clampLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const probe = limit + 1; // one extra row is how "is there a next page" is answered

  const people: PersonHit[] = [];
  let next_cursor: string | null = null;

  const decoded = decodeCursor(input.cursor) as
    | { kind?: string; rank?: number; id?: string; prefix?: number }
    | null;
  if (decoded !== null && decoded.kind !== "people") {
    // A cursor decodes fine but carries the WRONG ARRAY's keyset - most
    // likely a cursor issued by a different tool. Silently restarting at
    // page 1 would hand back duplicate rows with nothing to signal it, so
    // this is refused the same way a garbage cursor already is.
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this server issued for the people array",
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
    next_cursor = encodeCursor(
      usePrefix
        ? { kind: "people", rank: last.rank, id: last.id, prefix: 1 }
        : { kind: "people", rank: last.rank, id: last.id }
    );
  }

  return { people, next_cursor };
}
