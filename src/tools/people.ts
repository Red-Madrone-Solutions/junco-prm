import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import type { Person, PersonDetail } from "../types";

export type { Person, PersonDetail } from "../types";

interface PersonRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  organization: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

import { findDuplicateCandidates, STRONG_MATCH } from "./duplicates";

export function toPerson(row: PersonRow): Person {
  return { record_kind: "person", ...row };
}

const WRITABLE = ["full_name", "preferred_name", "job_title", "organization", "notes"] as const;
type Writable = (typeof WRITABLE)[number];

export interface CreatePersonInput {
  full_name: string;
  preferred_name?: string | null;
  job_title?: string | null;
  organization?: string | null;
  notes?: string | null;
  /**
   * An email is not stored by this tool - `add_contact` owns contact methods -
   * but it is accepted here because it is the strongest duplicate evidence there
   * is, and an agent that has one should not have to create a probable duplicate
   * before it can find that out.
   */
  email?: string;
  /** Create even on a strong match. The agent has seen the candidates and chosen. */
  force?: boolean;
  idempotency_key?: string;
}

function requireName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError("invalid_input", "full_name is required and must be a non-empty string");
  }
  return value.trim();
}

export async function createPerson(ctx: ToolContext, input: CreatePersonInput): Promise<Person> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "create_person", idempotency_key, rest, async () => {
    const full_name = requireName(input.full_name);

    // The duplicate check runs BEFORE the insert and before the id is minted.
    // "Add Jane, I just met her" against a roster row waiting to be promoted
    // creates a durable duplicate and loses her provenance permanently.
    // Run the check even under `force`, because the WEAK candidates are worth
    // returning either way - see below.
    const candidates = await findDuplicateCandidates(ctx, {
      full_name,
      organization: input.organization ?? undefined,
      email: input.email,
    });

    if (input.force !== true) {
      const strong = candidates.filter((c) => c.score >= STRONG_MATCH);
      if (strong.length > 0) {
        // A roster hit and a person hit call for different next moves, and the
        // roster one is named first because promoting keeps provenance while
        // forcing throws it away.
        const roster = strong.find((c) => c.record_kind === "roster_entry");
        throw new ToolError(
          "conflict",
          `${full_name} closely matches ${strong.length} existing record(s)`,
          roster
            ? `call promote_roster_entry with roster_entry_id ${roster.id} to keep this person's provenance, or call create_person again with force: true to create a separate record`
            : "call create_person again with force: true if this is genuinely a different person",
          strong
        );
      }
    }

    const id = newId("p");
    const at = nowIso(ctx.clock);

    await ctx.db
      .prepare(
        `INSERT INTO people (id, full_name, preferred_name, job_title, organization, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        full_name,
        input.preferred_name ?? null,
        input.job_title ?? null,
        input.organization ?? null,
        input.notes ?? null,
        at,
        at
      )
      .run();

    const person = await loadPerson(ctx, id);

    // SUB-THRESHOLD CANDIDATES ARE RETURNED ON SUCCESS, and this is what closes
    // most of the bare-name gap without ever blocking a legitimate create.
    //
    // A bare name scores 1 and does not refuse, because the reference roster
    // carries 11 duplicated names across 23 rows and refusing would make "add
    // Chris Smith" a two-call operation on any roster holding two of them. But
    // the case this whole check exists for - "add Jane, I just met her" against
    // an unpromoted roster row - often produces exactly that weak match, and
    // saying nothing meant the agent never learned the roster row was there.
    //
    // Now it is created AND the agent is told what it nearly duplicated, so it
    // can call delete_person and promote_roster_entry instead. That is strictly
    // more information than it had, and it costs one optional field.
    return candidates.length > 0 ? { ...person, possible_duplicates: candidates } : person;
  });
}

export interface UpdatePersonInput extends Partial<Record<Writable, string | null>> {
  person_id: string;
  idempotency_key?: string;
}

export async function updatePerson(ctx: ToolContext, input: UpdatePersonInput): Promise<Person> {
  const { idempotency_key, ...rest } = input;
  // The id is validated OUT here rather than inside the closure, so it can be
  // passed as the subject. See "Every person-scoped write records its subject"
  // in Task 4 - this is the pattern every such tool follows.
  const personId = assertId("p", input.person_id);
  return withIdempotency(
    ctx,
    "update_person",
    idempotency_key,
    rest,
    async () => {
      const id = personId;
      // NOTE FOR THE IMPLEMENTER: the body below is unchanged from the version
      // that validated `id` inside the closure. Only the two lines above and
      // the `personId` argument at the bottom of this call are new.

      const sets: string[] = [];
      const values: (string | null)[] = [];
      for (const field of WRITABLE) {
        if (!(field in input)) continue;
        const value = input[field];
        if (field === "full_name") {
          sets.push("full_name = ?");
          values.push(requireName(value));
        } else {
          sets.push(`${field} = ?`);
          values.push(value ?? null);
        }
      }

      if (sets.length === 0) {
        throw new ToolError("invalid_input", "update_person needs at least one field to change");
      }

      sets.push("updated_at = ?");
      values.push(nowIso(ctx.clock));

      const result = await ctx.db
        .prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...values, id)
        .run();

      if (result.meta.changes === 0) {
        throw new ToolError("not_found", `no person with id ${id}`);
      }

      return loadPerson(ctx, id);
    },
    personId
  );
}

export async function loadPerson(ctx: ToolContext, id: string): Promise<Person> {
  const row = await ctx.db
    .prepare(
      `SELECT id, full_name, preferred_name, job_title, organization, notes, archived_at, created_at, updated_at
       FROM people WHERE id = ?`
    )
    .bind(id)
    .first<PersonRow>();
  if (!row) throw new ToolError("not_found", `no person with id ${id}`);
  return toPerson(row);
}

export interface GetPersonInput {
  person_id: string;
  encounter_limit?: number;
  encounter_cursor?: string;
}

export async function getPerson(ctx: ToolContext, input: GetPersonInput): Promise<PersonDetail> {
  const id = assertId("p", input.person_id);
  const person = await loadPerson(ctx, id);
  return {
    ...person,
    contacts: [],
    links: [],
    tags: [],
    sources: [],
    open_followups: [],
    recent_encounters: [],
    encounter_count: 0,
    encounter_next_cursor: null,
  };
}
