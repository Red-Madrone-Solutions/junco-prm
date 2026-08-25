import type { ToolContext } from "../context";
import type { Followup } from "../types";

export type { Followup } from "../types";

const COLUMNS = "id, person_id, due_on, note, completed_at, cancelled_at";

export function toFollowup(row: Omit<Followup, "record_kind">): Followup {
  return { record_kind: "followup", ...row };
}

export async function loadOpenFollowups(ctx: ToolContext, personId: string): Promise<Followup[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM followups
       WHERE person_id = ? AND completed_at IS NULL AND cancelled_at IS NULL
       ORDER BY due_on, id`
    )
    .bind(personId)
    .all<Omit<Followup, "record_kind">>();
  return results.map(toFollowup);
}
