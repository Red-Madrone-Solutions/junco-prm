import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId } from "../ids";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";

/**
 * The allowlist, and the only thing `scope` is ever checked against. Kept as an
 * array rather than derived from `QUERIES` so the check does not depend on how
 * that object resolves a key - which is the defect below.
 */
export const EXPORT_SCOPES = ["people", "encounters", "followups"] as const;

export type ExportScope = (typeof EXPORT_SCOPES)[number];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * NULL PROTOTYPE, NOT A PLAIN OBJECT LITERAL, and the difference was a live
 * defect. As `{...}` this map inherits from `Object.prototype`, so
 * `QUERIES["toString"]` resolved to `Function.prototype.toString`, the
 * `base === undefined` guard passed, and the function's source text was
 * concatenated into the SQL. `export_data({scope: "toString"})` returned
 * `D1_ERROR: near "function": syntax error` - a raw error carrying no `code`,
 * escaping the closed set of seven that clients and tests bind to. The scope
 * check against EXPORT_SCOPES below is the real fix; this is the second one, so
 * the next key indexed into this map cannot do the same thing.
 */
const QUERIES: Record<ExportScope, string> = Object.assign(Object.create(null), {
  people: `SELECT id, full_name, preferred_name, job_title, organization, notes,
                  archived_at, created_at, updated_at
           FROM people`,
  encounters: `SELECT id, person_id, occurred_on, occurred_at, location, event, summary, created_at
               FROM encounters`,
  followups: `SELECT id, person_id, due_on, note, completed_at, cancelled_at, created_at
              FROM followups`,
});

// The keyset id is prefixed differently per table, so a cursor issued for one
// scope is rejected by assertId if replayed against another rather than
// silently paging the wrong table.
// Null prototype for the same reason as QUERIES above.
const ID_PREFIX: Record<ExportScope, "p" | "enc" | "fu"> = Object.assign(Object.create(null), {
  people: "p",
  encounters: "enc",
  followups: "fu",
});

export interface ExportDataInput {
  scope?: ExportScope;
  limit?: number;
  cursor?: string;
}

/**
 * `decodeCursor` only guarantees the token decodes to a plain object - it does
 * not know this tool's keyset is a bare `id`. Without this check a cursor that
 * decodes fine but carries no `id` field (or one of the wrong type) would bind
 * `undefined` into the query below instead of being refused up front.
 */
function decodeExportCursor(scope: ExportScope, cursor: string | undefined): { id: string } | null {
  const decoded = decodeCursor(cursor);
  if (decoded === null) return null;
  const { id } = decoded as { id?: string };
  if (typeof id !== "string") {
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this tool issued",
      "call export_data again without a cursor to start from the first page"
    );
  }
  return { id: assertId(ID_PREFIX[scope], id) };
}

export async function exportData(
  ctx: ToolContext,
  input: ExportDataInput
): Promise<{ scope: ExportScope; results: unknown[]; next_cursor: string | null }> {
  const requested = input.scope ?? "people";
  // Validated against the allowlist BEFORE anything is indexed by it. An
  // `undefined` check on the lookup result is not a substitute: see the comment
  // on QUERIES.
  if (!(EXPORT_SCOPES as readonly string[]).includes(requested)) {
    throw new ToolError(
      "invalid_input",
      'scope must be "people", "encounters", or "followups". Staged roster data is not exported; it is re-fetchable from its source.',
      `call export_data again with scope set to one of: ${EXPORT_SCOPES.join(", ")}`
    );
  }
  const scope = requested as ExportScope;
  const base = QUERIES[scope];

  const limit = clampLimit(input.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const after = decodeExportCursor(scope, input.cursor);
  const clause = after === null ? "" : "WHERE id > ?";
  const values = after === null ? [] : [after.id];

  const { results } = await ctx.db
    .prepare(`${base} ${clause} ORDER BY id ASC LIMIT ?`)
    .bind(...values, limit + 1)
    .all<Record<string, unknown>>();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const next =
    results.length > limit && last !== undefined
      ? encodeCursor({ id: String(last["id"]) })
      : null;

  return { scope, results: page, next_cursor: next };
}
