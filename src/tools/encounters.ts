import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { isLocalDate, localDate, nowIso } from "../time";
import type { Encounter, PersonDetail } from "../types";
import { loadEncounter } from "./encounters_read";
import { getPerson, loadPerson } from "./people";

export type { Encounter } from "../types";
export {
  listEncounters,
  loadEncounter,
  loadRecentEncounters,
  type ListEncountersInput,
} from "./encounters_read";

function requireSummary(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError("invalid_input", "summary is required and must be a non-empty string");
  }
  return value.trim();
}

function resolveOccurredOn(ctx: ToolContext, value: unknown): string {
  if (value === undefined || value === null) return localDate(ctx.timezone, ctx.clock());
  if (!isLocalDate(value)) {
    throw new ToolError("invalid_input", "occurred_on must be a YYYY-MM-DD local date");
  }
  return value;
}

export interface LogEncounterInput {
  person_id: string;
  summary: string;
  occurred_on?: string;
  occurred_at?: string | null;
  location?: string | null;
  event?: string | null;
  idempotency_key?: string;
}

export async function logEncounter(
  ctx: ToolContext,
  input: LogEncounterInput
): Promise<{ encounter: Encounter; person: PersonDetail }> {
  const { idempotency_key, ...rest } = input;
  // The id is validated OUT here rather than inside the closure, so it can be
  // passed as the subject - the pattern every person-scoped write in this
  // codebase follows (see `updatePerson` and every tool in `attributes.ts`).
  const personId = assertId("p", input.person_id);
  return withIdempotency(
    ctx,
    "log_encounter",
    idempotency_key,
    rest,
    async () => {
      await loadPerson(ctx, personId);

      const summary = requireSummary(input.summary);
      const occurredOn = resolveOccurredOn(ctx, input.occurred_on);
      const id = newId("enc");
      const at = nowIso(ctx.clock);

      await ctx.db
        .prepare(
          `INSERT INTO encounters (id, person_id, occurred_on, occurred_at, location, event, summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          personId,
          occurredOn,
          input.occurred_at ?? null,
          input.location ?? null,
          input.event ?? null,
          summary,
          at,
          at
        )
        .run();

      return {
        encounter: await loadEncounter(ctx, id),
        person: await getPerson(ctx, { person_id: personId }),
      };
    },
    personId
  );
}

export interface UpdateEncounterInput {
  encounter_id: string;
  summary?: string;
  occurred_on?: string;
  location?: string | null;
  event?: string | null;
  idempotency_key?: string;
}

export async function updateEncounter(
  ctx: ToolContext,
  input: UpdateEncounterInput
): Promise<Encounter> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(
    ctx,
    "update_encounter",
    idempotency_key,
    rest,
    async () => {
      const id = assertId("enc", input.encounter_id);
      const sets: string[] = [];
      const values: (string | null)[] = [];

      if ("summary" in input) {
        sets.push("summary = ?");
        values.push(requireSummary(input.summary));
      }
      if ("occurred_on" in input) {
        sets.push("occurred_on = ?");
        values.push(resolveOccurredOn(ctx, input.occurred_on));
      }
      if ("location" in input) {
        sets.push("location = ?");
        values.push(input.location ?? null);
      }
      if ("event" in input) {
        sets.push("event = ?");
        values.push(input.event ?? null);
      }
      if (sets.length === 0) {
        throw new ToolError("invalid_input", "update_encounter needs at least one field to change");
      }

      sets.push("updated_at = ?");
      values.push(nowIso(ctx.clock));

      const result = await ctx.db
        .prepare(`UPDATE encounters SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...values, id)
        .run();
      if (result.meta.changes === 0) throw new ToolError("not_found", `no encounter with id ${id}`);

      return loadEncounter(ctx, id);
    },
    // No subjectId: `encounter_id` is the only identifier this input carries,
    // and the person it belongs to is not known until the row is loaded. Same
    // situation as `create_person`'s newly-minted id - see subjectFromResult's
    // doc comment in idempotency.ts.
    undefined,
    (encounter) => encounter.person_id
  );
}

export interface DeleteEncounterInput {
  encounter_id: string;
  idempotency_key?: string;
}

export async function deleteEncounter(
  ctx: ToolContext,
  input: DeleteEncounterInput
): Promise<{ status: "deleted"; deleted: Encounter }> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(
    ctx,
    "delete_encounter",
    idempotency_key,
    rest,
    async () => {
      const id = assertId("enc", input.encounter_id);
      const existing = await loadEncounter(ctx, id);
      await ctx.db.prepare("DELETE FROM encounters WHERE id = ?").bind(id).run();
      return { status: "deleted" as const, deleted: existing };
    },
    undefined,
    (result) => result.deleted.person_id
  );
}
