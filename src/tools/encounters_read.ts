import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId } from "../ids";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";
import { isLocalDate } from "../time";
import type { Encounter } from "../types";

export type { Encounter } from "../types";

export interface EncounterRow {
  id: string;
  person_id: string;
  person_name: string;
  occurred_on: string;
  occurred_at: string | null;
  location: string | null;
  event: string | null;
  summary: string;
  created_at: string;
  updated_at: string;
}

// Qualified because the JOIN below adds `people`, which also has id,
// created_at, and updated_at - bare column references become ambiguous the
// moment the second table appears, and SQLite reports that at query time.
export const COLUMNS =
  "e.id AS id, e.person_id AS person_id, e.occurred_on AS occurred_on, " +
  "e.occurred_at AS occurred_at, e.location AS location, e.event AS event, " +
  "e.summary AS summary, e.created_at AS created_at, e.updated_at AS updated_at, " +
  "p.full_name AS person_name";

export function toEncounter(row: EncounterRow): Encounter {
  return { record_kind: "encounter", ...row };
}

/**
 * The keyset this list pages on, encoded with the SHARED cursor helpers in
 * `src/paginate.ts` rather than a local `date|id` string.
 *
 * The previous draft rolled its own here, and a second one in `listRecords`, and
 * a third convention in `searchPeople`. Three encodings of the same idea is how
 * one of them ends up parsed by a caller who noticed the format was readable.
 * These helpers only name the fields; the encoding is not theirs to choose.
 */
function encodeEncounterCursor(encounter: Encounter): string {
  return encodeCursor({ occurred_on: encounter.occurred_on, id: encounter.id });
}

function decodeEncounterCursor(cursor: string | undefined): { occurred_on: string; id: string } | null {
  const decoded = decodeCursor(cursor);
  if (decoded === null) return null;
  const { occurred_on, id } = decoded as { occurred_on?: string; id?: string };
  if (typeof occurred_on !== "string" || typeof id !== "string" || !isLocalDate(occurred_on)) {
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this tool issued",
      "call list_encounters again without a cursor to start from the first page"
    );
  }
  return { occurred_on, id: assertId("enc", id) };
}

export async function loadEncounter(ctx: ToolContext, id: string): Promise<Encounter> {
  const row = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM encounters e JOIN people p ON p.id = e.person_id WHERE e.id = ?`)
    .bind(id)
    .first<EncounterRow>();
  if (!row) throw new ToolError("not_found", `no encounter with id ${id}`);
  return toEncounter(row);
}

export interface ListEncountersInput {
  person_id?: string;
  event?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export async function listEncounters(
  ctx: ToolContext,
  input: ListEncountersInput
): Promise<{ results: Encounter[]; next_cursor: string | null }> {
  const limit = clampLimit(input.limit, 20, 100);
  const clauses: string[] = [];
  const values: (string | number)[] = [];

  if (input.person_id !== undefined) {
    clauses.push("e.person_id = ?");
    values.push(assertId("p", input.person_id));
  }
  if (input.event !== undefined) {
    clauses.push("e.event = ?");
    values.push(input.event);
  }
  for (const [key, op] of [["since", ">="], ["until", "<="]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!isLocalDate(value)) {
      throw new ToolError("invalid_input", `${key} must be a YYYY-MM-DD local date`);
    }
    clauses.push(`e.occurred_on ${op} ?`);
    values.push(value);
  }
  const after = decodeEncounterCursor(input.cursor);
  if (after !== null) {
    // Keyset on the full sort key: strictly older dates, or the same date further
    // along in id order.
    clauses.push("(e.occurred_on < ? OR (e.occurred_on = ? AND e.id > ?))");
    values.push(after.occurred_on, after.occurred_on, after.id);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM encounters e JOIN people p ON p.id = e.person_id
       ${where}
       ORDER BY e.occurred_on DESC, e.id ASC
       LIMIT ?`
    )
    .bind(...values, limit + 1)
    .all<EncounterRow>();

  const page = results.slice(0, limit).map(toEncounter);
  const last = page[page.length - 1];
  const next = results.length > limit && last !== undefined ? encodeEncounterCursor(last) : null;
  return { results: page, next_cursor: next };
}

export async function loadRecentEncounters(
  ctx: ToolContext,
  personId: string,
  limit: number,
  cursor?: string
): Promise<{ results: Encounter[]; total: number; next_cursor: string | null }> {
  const page = await listEncounters(ctx, { person_id: personId, limit, cursor });

  const count = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM encounters WHERE person_id = ?")
    .bind(personId)
    .first<{ n: number }>();

  return { ...page, total: count?.n ?? 0 };
}
