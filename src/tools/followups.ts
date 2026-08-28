import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { clampLimit, decodeCursor, encodeCursor } from "../paginate";
import { isLocalDate, localDate, nowIso } from "../time";
import type { Followup, PersonDetail } from "../types";
import { loadOpenFollowups, toFollowup } from "./followups_read";
import { getPerson, loadPerson } from "./people";

export type { Followup } from "../types";
export { loadOpenFollowups } from "./followups_read";

export interface DueItem extends Followup {
  days_overdue: number;
}

type FollowupRow = Omit<Followup, "record_kind">;

// Qualified because the JOIN below adds `people`, which also has id,
// created_at, and updated_at - bare column references become ambiguous the
// moment the second table appears, and SQLite reports that at query time.
export const COLUMNS =
  "f.id AS id, f.person_id AS person_id, f.due_on AS due_on, f.note AS note, " +
  "f.completed_at AS completed_at, f.cancelled_at AS cancelled_at, " +
  "f.created_at AS created_at, f.updated_at AS updated_at, p.full_name AS person_name";

function requireLocalDate(value: unknown, field: string): string {
  if (!isLocalDate(value)) {
    throw new ToolError(
      "invalid_input",
      `${field} must be a YYYY-MM-DD local date interpreted in the owner's time zone`
    );
  }
  return value;
}

function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const day = 24 * 60 * 60 * 1000;
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const to = Date.parse(`${toIsoDate}T00:00:00Z`);
  return Math.round((to - from) / day);
}

function decodeFollowupCursor(cursor: string | undefined): { due_on: string; id: string } | null {
  const decoded = decodeCursor(cursor);
  if (decoded === null) return null;
  const { due_on, id } = decoded as { due_on?: string; id?: string };
  if (typeof due_on !== "string" || typeof id !== "string" || !isLocalDate(due_on)) {
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this tool issued",
      "call list_due again without a cursor to start from the first page"
    );
  }
  return { due_on, id: assertId("fu", id) };
}

export interface CreateFollowupInput {
  person_id: string;
  due_on: string;
  note?: string | null;
  idempotency_key?: string;
}

export async function createFollowup(
  ctx: ToolContext,
  input: CreateFollowupInput
): Promise<{ followup: Followup; person: PersonDetail }> {
  const { idempotency_key, ...rest } = input;
  // The id is validated OUT here rather than inside the closure, so it can be
  // passed as the subject - the pattern every person-scoped write in this
  // codebase follows (see `updatePerson` and `logEncounter`).
  const personId = assertId("p", input.person_id);
  return withIdempotency(
    ctx,
    "create_followup",
    idempotency_key,
    rest,
    async () => {
      await loadPerson(ctx, personId);
      const dueOn = requireLocalDate(input.due_on, "due_on");

      const id = newId("fu");
      const at = nowIso(ctx.clock);
      await ctx.db
        .prepare(
          `INSERT INTO followups (id, person_id, due_on, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(id, personId, dueOn, input.note ?? null, at, at)
        .run();

      return {
        followup: await loadFollowup(ctx, id),
        person: await getPerson(ctx, { person_id: personId }),
      };
    },
    personId
  );
}

export async function loadFollowup(ctx: ToolContext, id: string): Promise<Followup> {
  const row = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM followups f JOIN people p ON p.id = f.person_id WHERE f.id = ?`)
    .bind(id)
    .first<FollowupRow>();
  if (!row) throw new ToolError("not_found", `no follow-up with id ${id}`);
  return toFollowup(row);
}

export interface CloseFollowupInput {
  followup_id: string;
  idempotency_key?: string;
}

async function closeFollowup(
  ctx: ToolContext,
  input: CloseFollowupInput,
  tool: string,
  column: "completed_at" | "cancelled_at"
): Promise<Followup> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(
    ctx,
    tool,
    idempotency_key,
    rest,
    async () => {
      const id = assertId("fu", input.followup_id);
      const result = await ctx.db
        .prepare(
          `UPDATE followups SET ${column} = ?, updated_at = ?
           WHERE id = ? AND completed_at IS NULL AND cancelled_at IS NULL`
        )
        .bind(nowIso(ctx.clock), nowIso(ctx.clock), id)
        .run();

      if (result.meta.changes === 0) {
        const existing = await ctx.db
          .prepare("SELECT id FROM followups WHERE id = ?")
          .bind(id)
          .first<{ id: string }>();
        if (!existing) throw new ToolError("not_found", `no follow-up with id ${id}`);
        throw new ToolError("conflict", `follow-up ${id} is already closed`);
      }

      return loadFollowup(ctx, id);
    },
    // No subjectId: `followup_id` is the only identifier this input carries,
    // and the person it belongs to is not known until the row is loaded. Same
    // situation as `update_encounter`/`delete_encounter` - see
    // subjectFromResult's doc comment in idempotency.ts.
    undefined,
    (followup) => followup.person_id
  );
}

export function completeFollowup(ctx: ToolContext, input: CloseFollowupInput): Promise<Followup> {
  return closeFollowup(ctx, input, "complete_followup", "completed_at");
}

export function cancelFollowup(ctx: ToolContext, input: CloseFollowupInput): Promise<Followup> {
  return closeFollowup(ctx, input, "cancel_followup", "cancelled_at");
}

export interface UpdateFollowupInput {
  followup_id: string;
  note?: string | null;
  due_on?: string;
  idempotency_key?: string;
}

export async function updateFollowup(
  ctx: ToolContext,
  input: UpdateFollowupInput
): Promise<Followup> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(
    ctx,
    "update_followup",
    idempotency_key,
    rest,
    async () => {
      const id = assertId("fu", input.followup_id);

      // `note` may be explicitly null, which clears it, so presence is what
      // matters rather than truthiness.
      const setsNote = Object.prototype.hasOwnProperty.call(input, "note");
      const setsDue = input.due_on !== undefined;
      if (!setsNote && !setsDue) {
        throw new ToolError(
          "invalid_input",
          "update_followup needs note, due_on, or both",
          "call it again with the field you mean to change"
        );
      }
      // The project's own date contract, not a regex. A regex accepts
      // 2026-99-99, and createFollowup already refuses that.
      if (setsDue) requireLocalDate(input.due_on as string, "due_on");

      const sets: string[] = [];
      const binds: (string | null)[] = [];
      if (setsNote) {
        sets.push("note = ?");
        binds.push(input.note ?? null);
      }
      if (setsDue) {
        sets.push("due_on = ?");
        binds.push(input.due_on as string);
      }
      sets.push("updated_at = ?");
      binds.push(nowIso(ctx.clock));

      // Conditional on both closed columns in the same statement. A read then
      // a write can race with a completion landing between them and would edit
      // a closed record. Same guard closeFollowup uses, for the same reason.
      const result = await ctx.db
        .prepare(
          `UPDATE followups SET ${sets.join(", ")}
           WHERE id = ? AND completed_at IS NULL AND cancelled_at IS NULL`
        )
        .bind(...binds, id)
        .run();

      if (result.meta.changes === 0) {
        const existing = await ctx.db
          .prepare("SELECT id FROM followups WHERE id = ?")
          .bind(id)
          .first<{ id: string }>();
        if (!existing) throw new ToolError("not_found", `no follow-up with id ${id}`);
        throw new ToolError(
          "conflict",
          `follow-up ${id} is closed and cannot be edited`,
          "a closed follow-up is a record of what happened; create a new one instead"
        );
      }

      return loadFollowup(ctx, id);
    },
    undefined,
    (followup) => followup.person_id
  );
}

export interface ListDueInput {
  through?: string;
  limit?: number;
  cursor?: string;
}

export async function listDue(
  ctx: ToolContext,
  input: ListDueInput
): Promise<{
  results: DueItem[];
  as_of: string;
  timezone: string;
  next_cursor: string | null;
}> {
  const asOf = localDate(ctx.timezone, ctx.clock());
  const through = input.through === undefined ? asOf : requireLocalDate(input.through, "through");
  // Same convention as every other read: throws limit_exceeded above the max
  // rather than clamping, because a silent clamp tells the agent it received
  // everything that is owed.
  const limit = clampLimit(input.limit, 50, 200);

  const after = decodeFollowupCursor(input.cursor);
  const keyset = after === null ? "" : "AND (f.due_on > ? OR (f.due_on = ? AND f.id > ?))";
  const keysetValues = after === null ? [] : [after.due_on, after.due_on, after.id];

  const { results } = await ctx.db
    .prepare(
      `SELECT f.id AS id, f.person_id AS person_id, f.due_on AS due_on, f.note AS note,
              f.completed_at AS completed_at, f.cancelled_at AS cancelled_at,
              f.created_at AS created_at, f.updated_at AS updated_at,
              p.full_name AS person_name
       FROM followups f
       JOIN people p ON p.id = f.person_id
       WHERE f.completed_at IS NULL AND f.cancelled_at IS NULL
         AND f.due_on <= ?
         ${keyset}
       ORDER BY f.due_on ASC, f.id ASC
       LIMIT ?`
    )
    .bind(through, ...keysetValues, limit + 1)
    .all<FollowupRow>();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];

  return {
    results: page.map((row) => ({
      ...toFollowup(row),
      days_overdue: Math.max(daysBetween(row.due_on, asOf), 0),
    })),
    as_of: asOf,
    timezone: ctx.timezone,
    next_cursor:
      results.length > limit && last !== undefined
        ? encodeCursor({ due_on: last.due_on, id: last.id })
        : null,
  };
}
