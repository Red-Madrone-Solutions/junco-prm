import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId } from "../ids";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";

/**
 * The allowlist, and the only thing `scope` is ever checked against. Kept as an
 * array rather than derived from `QUERIES` so the check does not depend on how
 * that object resolves a key - which is the defect below.
 */
export const LIST_SCOPES = ["people", "encounters", "followups"] as const;

export type ListScope = (typeof LIST_SCOPES)[number];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// `include` fans out into one extra statement per relation, each scanning the
// same page predicate. Capped lower than the plain-list MAX_LIMIT so that
// fan-out stays bounded even at the ceiling.
const INCLUDE_MAX_LIMIT = 100;

const INCLUDE_RELATIONS = ["tags", "links", "contacts"] as const;
type IncludeRelation = (typeof INCLUDE_RELATIONS)[number];

// Only the people scope has these relation tables. encounters and followups
// have no person_tags/person_links/person_contacts join point, so include is
// refused there rather than silently returning nothing.
const INCLUDE_SCOPES: readonly ListScope[] = ["people"];

/**
 * NULL PROTOTYPE, NOT A PLAIN OBJECT LITERAL, and the difference was a live
 * defect. As `{...}` this map inherits from `Object.prototype`, so
 * `QUERIES["toString"]` resolved to `Function.prototype.toString`, the
 * `base === undefined` guard passed, and the function's source text was
 * concatenated into the SQL. `list_records({scope: "toString"})` (then still
 * named `export_data`) returned `D1_ERROR: near "function": syntax error` - a
 * raw error carrying no `code`, escaping the closed set of seven that clients
 * and tests bind to. The scope check against LIST_SCOPES below is the real
 * fix; this is the second one, so the next key indexed into this map cannot do
 * the same thing.
 */
const QUERIES: Record<ListScope, string> = Object.assign(Object.create(null), {
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
const ID_PREFIX: Record<ListScope, "p" | "enc" | "fu"> = Object.assign(Object.create(null), {
  people: "p",
  encounters: "enc",
  followups: "fu",
});

export interface ListRecordsInput {
  scope?: ListScope;
  archived?: boolean;
  limit?: number;
  cursor?: string;
  include?: string[];
}

/**
 * The page's identity, expressed once as a `SELECT id FROM <table> WHERE ...
 * ORDER BY id LIMIT ?` subquery. The main page query and every relation
 * subquery in `loadRelations` embed this exact subquery text and bind this
 * exact array, so a filter added here later (an `updated_after` or a `tags`
 * filter) reaches both without a second place to remember it - there is no
 * way for the page and its relations to select different people because they
 * are not two predicates kept in sync, they are one.
 *
 * Binding the filter's own values, never the ids that satisfy it, is what
 * keeps this off D1's 100 parameter ceiling: this binds one value per filter,
 * not one value per matched person.
 */
function buildPagePredicate(
  scope: ListScope,
  input: ListRecordsInput,
  after: { id: string } | null,
  probeLimit: number
): { sql: string; binds: unknown[] } {
  // `archived` only means anything for the people scope: encounters and
  // follow-ups carry no archived_at of their own. Excluding archived people by
  // default aligns this with search_people, which already defaults to
  // excluding them; export_data's old behaviour of always returning them,
  // with no way to filter, is the drift this closes.
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (scope === "people" && input.archived !== true) {
    filters.push("archived_at IS NULL");
  }
  if (after !== null) {
    filters.push("id > ?");
    binds.push(after.id);
  }
  const clause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  binds.push(probeLimit);
  return { sql: `SELECT id FROM ${scope} ${clause} ORDER BY id ASC LIMIT ?`, binds };
}

/**
 * Refuses and normalizes `include` before anything downstream sees it.
 * `include` only exists for the people scope, since encounters and followups
 * have no person_tags/person_links/person_contacts join point.
 */
function validateInclude(scope: ListScope, raw: string[] | undefined): IncludeRelation[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== "string")) {
    throw new ToolError("invalid_input", "include must be an array of strings");
  }
  if (raw.length === 0) return [];
  if (!INCLUDE_SCOPES.includes(scope)) {
    throw new ToolError(
      "invalid_input",
      `include is not supported for scope "${scope}"; only "people" has tags, links, and contacts`,
      'call list_records again with scope: "people", or without include'
    );
  }
  const invalid = raw.find((r) => !(INCLUDE_RELATIONS as readonly string[]).includes(r));
  if (invalid !== undefined) {
    throw new ToolError(
      "invalid_input",
      `include must be drawn from ${INCLUDE_RELATIONS.join(", ")}; got "${invalid}"`,
      `call list_records again with include values drawn from: ${INCLUDE_RELATIONS.join(", ")}`
    );
  }
  return [...new Set(raw)] as IncludeRelation[];
}

/**
 * One statement per relation, binding NO list of person ids.
 *
 * Two wrong ways to do this, both of which fail only at scale:
 *
 * A join against person_tags or person_contacts is one-to-many, so row count
 * stops meaning person count. A page of 100 returns fewer than 100 people and
 * the keyset lands on the last ROW rather than the last person.
 *
 * Paging people first and then binding their ids collides with D1's 100
 * parameter ceiling, which docs/MEASUREMENTS.md records as still binding and
 * which is why KEY_LOOKUP_CHUNK is 99. A hundred ids consumes the entire
 * budget, leaving none for the other filters, and it fails at exactly the
 * maximum a caller is most likely to ask for.
 *
 * So the page predicate is repeated as a subquery instead. Three extra
 * statements, no id list, no interaction with the parameter cap.
 */
async function loadRelations(
  ctx: ToolContext,
  include: string[],
  pagePredicate: { sql: string; binds: unknown[] }
): Promise<Record<string, Record<string, unknown[]>>> {
  const out: Record<string, Record<string, unknown[]>> = {};

  if (include.includes("tags")) {
    const rows = await ctx.db
      .prepare(
        `SELECT pt.person_id, t.name
         FROM person_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.person_id IN (${pagePredicate.sql})
         ORDER BY t.name`
      )
      .bind(...pagePredicate.binds)
      .all<{ person_id: string; name: string }>();
    out.tags = {};
    for (const row of rows.results) (out.tags[row.person_id] ??= []).push(row.name);
  }

  if (include.includes("links")) {
    const rows = await ctx.db
      .prepare(
        `SELECT id, person_id, link_type, url FROM person_links
         WHERE person_id IN (${pagePredicate.sql}) ORDER BY id`
      )
      .bind(...pagePredicate.binds)
      .all<{ id: string; person_id: string; link_type: string; url: string }>();
    out.links = {};
    for (const row of rows.results) {
      const { person_id, ...link } = row;
      (out.links[person_id] ??= []).push(link);
    }
  }

  if (include.includes("contacts")) {
    const rows = await ctx.db
      .prepare(
        `SELECT id, person_id, contact_type, value, label FROM person_contacts
         WHERE person_id IN (${pagePredicate.sql}) ORDER BY id`
      )
      .bind(...pagePredicate.binds)
      .all<{ id: string; person_id: string; contact_type: string; value: string; label: string | null }>();
    out.contacts = {};
    for (const row of rows.results) {
      const { person_id, ...contact } = row;
      (out.contacts[person_id] ??= []).push(contact);
    }
  }

  return out;
}

/**
 * `decodeCursor` only guarantees the token decodes to a plain object - it does
 * not know this tool's keyset is a bare `id`. Without this check a cursor that
 * decodes fine but carries no `id` field (or one of the wrong type) would bind
 * `undefined` into the query below instead of being refused up front.
 */
function decodeListCursor(scope: ListScope, cursor: string | undefined): { id: string } | null {
  const decoded = decodeCursor(cursor);
  if (decoded === null) return null;
  const { id } = decoded as { id?: string };
  if (typeof id !== "string") {
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this tool issued",
      "call list_records again without a cursor to start from the first page"
    );
  }
  return { id: assertId(ID_PREFIX[scope], id) };
}

export async function listRecords(
  ctx: ToolContext,
  input: ListRecordsInput
): Promise<{ scope: ListScope; records: unknown[]; next_cursor: string | null }> {
  const requested = input.scope ?? "people";
  // Validated against the allowlist BEFORE anything is indexed by it. An
  // `undefined` check on the lookup result is not a substitute: see the comment
  // on QUERIES.
  if (!(LIST_SCOPES as readonly string[]).includes(requested)) {
    throw new ToolError(
      "invalid_input",
      'scope must be "people", "encounters", or "followups". Staged roster data is not listed here; it is re-fetchable from its source.',
      `call list_records again with scope set to one of: ${LIST_SCOPES.join(", ")}`
    );
  }
  const scope = requested as ListScope;
  const base = QUERIES[scope];

  const include = validateInclude(scope, input.include);

  const limit = clampLimit(input.limit, DEFAULT_LIMIT, include.length > 0 ? INCLUDE_MAX_LIMIT : MAX_LIMIT);

  const after = decodeListCursor(scope, input.cursor);

  // One extra row over `limit` is how "is there a next page" is answered
  // without a second COUNT query.
  const predicate = buildPagePredicate(scope, input, after, limit + 1);

  const { results } = await ctx.db
    .prepare(`${base} WHERE id IN (${predicate.sql}) ORDER BY id ASC`)
    .bind(...predicate.binds)
    .all<Record<string, unknown>>();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const next =
    results.length > limit && last !== undefined
      ? encodeCursor({ id: String(last["id"]) })
      : null;

  let records: unknown[] = page;
  if (include.length > 0) {
    const relations = await loadRelations(ctx, include, predicate);
    records = page.map((row) => {
      const id = String(row["id"]);
      const attached: Record<string, unknown[]> = {};
      for (const relation of include) {
        attached[relation] = relations[relation]?.[id] ?? [];
      }
      return { ...row, ...attached };
    });
  }

  return { scope, records, next_cursor: next };
}
