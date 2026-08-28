import type { ToolContext } from "../context";
import type { Followup } from "../types";

export type { Followup } from "../types";

// Qualified because the JOIN below adds `people`, which also has id,
// created_at, and updated_at - bare column references become ambiguous the
// moment the second table appears, and SQLite reports that at query time.
const COLUMNS =
  "f.id AS id, f.person_id AS person_id, f.due_on AS due_on, f.note AS note, " +
  "f.completed_at AS completed_at, f.cancelled_at AS cancelled_at, " +
  "f.created_at AS created_at, f.updated_at AS updated_at, p.full_name AS person_name";

export function toFollowup(row: Omit<Followup, "record_kind">): Followup {
  return { record_kind: "followup", ...row };
}

export async function loadOpenFollowups(ctx: ToolContext, personId: string): Promise<Followup[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM followups f JOIN people p ON p.id = f.person_id
       WHERE f.person_id = ? AND f.completed_at IS NULL AND f.cancelled_at IS NULL
       ORDER BY f.due_on, f.id`
    )
    .bind(personId)
    .all<Omit<Followup, "record_kind">>();
  return results.map(toFollowup);
}
