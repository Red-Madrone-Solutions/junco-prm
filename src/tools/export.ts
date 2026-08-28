import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId } from "../ids";
import { normalizeText } from "../normalize";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";
import { isIsoInstant } from "../time";
import { COLUMNS as ENCOUNTER_COLUMNS } from "./encounters_read";

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

// Each tag is one bound parameter and one EXISTS subquery in the page
// predicate. D1's parameter ceiling (docs/MEASUREMENTS.md) is 100; ten tags
// plus every other filter this tool can combine stays nowhere near it, so the
// cap is refused up front rather than left reachable from this direction.
const MAX_TAGS = 10;

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
  encounters: `SELECT ${ENCOUNTER_COLUMNS} FROM encounters`,
  followups: `SELECT id, person_id, due_on, note, completed_at, cancelled_at, created_at, updated_at
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
  updated_after?: string;
  tags?: string[];
  limit?: number;
  cursor?: string;
  include?: string[];
}

/**
 * Canonicalize before comparing. updated_at is TEXT and SQLite compares it
 * lexicographically, which is correct between two stored values and wrong
 * against caller input: `isIsoInstant` accepts a timestamp with no
 * milliseconds, and "Z" sorts above ".", so a truncated watermark silently
 * excludes every record written in that same second.
 *
 * THE KEYSET IS (updated_at, id), NOT updated_at ALONE. Exclusivity on a
 * timestamp by itself loses records: if more rows share an instant than fit in
 * a page, advancing the watermark past that instant drops the remainder
 * permanently. The comparison is
 *   WHERE (updated_at > ?) OR (updated_at = ? AND id > ?)
 * which excludes exactly the last row returned rather than every row sharing
 * its timestamp, and the cursor carries both halves.
 *
 * Validate against isIsoInstant before canonicalizing. Date.parse alone
 * accepts "2026-08-27", "08/27/2026", and "1".
 *
 * Exclusive, which is what a watermark loop wants: a caller records the
 * newest updated_at it saw and passes it back, and must not be handed the
 * same record again.
 */
function canonicalInstant(value: string): string {
  if (!isIsoInstant(value)) {
    throw new ToolError(
      "invalid_input",
      "updated_after must be an ISO 8601 instant, for example 2026-08-27T12:00:00.000Z"
    );
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ToolError(
      "invalid_input",
      "updated_after must be an ISO 8601 instant, for example 2026-08-27T12:00:00.000Z"
    );
  }
  return new Date(parsed).toISOString();
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
 *
 * `updatedAfter`, once canonicalized by the caller, is the entry point for the
 * delta filter and its keyset: it lands in this one predicate, so the main
 * page query and every relation subquery in `loadRelations` pick it up
 * automatically, with no second place to apply it.
 *
 * `tags`, once validated and normalized by the caller, lands here too, as one
 * `EXISTS` clause per tag rather than a `JOIN` - a join makes row count stop
 * meaning person count, the same defect `loadRelations`'s doc comment
 * describes for relations. `EXISTS` per tag gives AND semantics without a
 * `GROUP BY ... HAVING COUNT` and without binding a list of matched ids, so
 * this stays off D1's parameter ceiling the same way every other filter here
 * does: one bound value per filter, never one per matched person.
 */
function buildPagePredicate(
  scope: ListScope,
  input: ListRecordsInput,
  after: { id: string; updated_at?: string } | null,
  probeLimit: number,
  updatedAfter: string | null,
  tags: string[]
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
  if (updatedAfter !== null) {
    filters.push("updated_at > ?");
    binds.push(updatedAfter);
  }
  for (const tag of tags) {
    filters.push(
      `EXISTS (SELECT 1 FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = ${scope}.id AND t.name = ?)`
    );
    binds.push(tag);
  }
  if (after !== null) {
    if (updatedAfter !== null) {
      // The keyset for a delta page: strictly later timestamps, or the same
      // timestamp further along in id order. `decodeListCursor` guarantees
      // `after.updated_at` is present whenever `updatedAfter` is, so this
      // never binds `undefined`.
      filters.push("(updated_at > ? OR (updated_at = ? AND id > ?))");
      binds.push(after.updated_at, after.updated_at, after.id);
    } else {
      filters.push("id > ?");
      binds.push(after.id);
    }
  }
  const clause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  binds.push(probeLimit);
  const orderBy = updatedAfter !== null ? "updated_at ASC, id ASC" : "id ASC";
  return { sql: `SELECT id FROM ${scope} ${clause} ORDER BY ${orderBy} LIMIT ?`, binds };
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
 * Refuses and normalizes `tags` before anything downstream sees it, the same
 * way `validateInclude` does for `include`. Only the people scope has a
 * person_tags join point, so `tags` is refused elsewhere rather than silently
 * matching nothing.
 */
function validateTags(scope: ListScope, raw: string[] | undefined): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== "string")) {
    throw new ToolError("invalid_input", "tags must be an array of strings");
  }
  if (raw.length === 0) return [];
  if (!INCLUDE_SCOPES.includes(scope)) {
    throw new ToolError(
      "invalid_input",
      `tags is not supported for scope "${scope}"; only "people" carries tags`,
      'call list_records again with scope: "people", or without tags'
    );
  }
  if (raw.length > MAX_TAGS) {
    throw new ToolError(
      "limit_exceeded",
      `tags accepts at most ${MAX_TAGS} names`,
      `call list_records again with ${MAX_TAGS} or fewer tags`
    );
  }
  return raw.map((t) => normalizeText(t));
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
 * not know this tool's keyset is a bare `id`, or `(updated_at, id)` once a
 * delta is in play. Without this check a cursor that decodes fine but carries
 * no `id` field (or one of the wrong type) would bind `undefined` into the
 * query below instead of being refused up front.
 *
 * `requireUpdatedAt` is true exactly when the current call passed
 * `updated_after`: the keyset for a delta page needs both halves of the
 * cursor, so a cursor missing `updated_at` here means it was issued by a
 * plain (non-delta) page and is being replayed into the wrong mode, which is
 * refused the same way a foreign-scope cursor is.
 */
function decodeListCursor(
  scope: ListScope,
  cursor: string | undefined,
  requireUpdatedAt: boolean
): { id: string; updated_at?: string } | null {
  const decoded = decodeCursor(cursor);
  if (decoded === null) return null;
  const { id, updated_at } = decoded as { id?: string; updated_at?: string };
  if (typeof id !== "string" || (requireUpdatedAt && typeof updated_at !== "string")) {
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this tool issued",
      "call list_records again without a cursor to start from the first page"
    );
  }
  return { id: assertId(ID_PREFIX[scope], id), updated_at };
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
  const tags = validateTags(scope, input.tags);

  const updatedAfter = input.updated_after !== undefined ? canonicalInstant(input.updated_after) : null;

  const limit = clampLimit(input.limit, DEFAULT_LIMIT, include.length > 0 ? INCLUDE_MAX_LIMIT : MAX_LIMIT);

  const after = decodeListCursor(scope, input.cursor, updatedAfter !== null);

  // One extra row over `limit` is how "is there a next page" is answered
  // without a second COUNT query.
  const predicate = buildPagePredicate(scope, input, after, limit + 1, updatedAfter, tags);

  const orderBy = updatedAfter !== null ? "updated_at ASC, id ASC" : "id ASC";
  const { results } = await ctx.db
    .prepare(`${base} WHERE id IN (${predicate.sql}) ORDER BY ${orderBy}`)
    .bind(...predicate.binds)
    .all<Record<string, unknown>>();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const next =
    results.length > limit && last !== undefined
      ? encodeCursor(
          updatedAfter !== null
            ? { id: String(last["id"]), updated_at: String(last["updated_at"]) }
            : { id: String(last["id"]) }
        )
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
