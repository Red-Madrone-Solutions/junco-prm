import type { ToolContext } from "../context";
import { mintConfirmation, redeemConfirmation } from "../confirm";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import type { Person, PersonDetail } from "../types";
import { loadContacts, loadLinks, loadTags } from "./attributes_read";
import { loadRecentEncounters } from "./encounters_read";
import { loadOpenFollowups } from "./followups_read";
import { loadPersonSources } from "./promote_read";

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

import { findDuplicateCandidates, STRONG_MATCH, type DuplicateCandidate } from "./duplicates";

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

export async function createPerson(
  ctx: ToolContext,
  input: CreatePersonInput
): Promise<Person & { possible_duplicates?: DuplicateCandidate[] }> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(
    ctx,
    "create_person",
    idempotency_key,
    rest,
    async () => {
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
    },
    // No subjectId: the id does not exist yet at this point, which is exactly
    // what subjectFromResult below is for.
    undefined,
    (person) => person.id
  );
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
  const [contacts, links, tags] = await Promise.all([
    loadContacts(ctx, id),
    loadLinks(ctx, id),
    loadTags(ctx, id),
  ]);
  const encounters = await loadRecentEncounters(
    ctx,
    id,
    input.encounter_limit ?? 10,
    input.encounter_cursor
  );
  const openFollowups = await loadOpenFollowups(ctx, id);
  const sources = await loadPersonSources(ctx, id);
  return {
    ...person,
    contacts,
    links,
    tags,
    sources,
    open_followups: openFollowups,
    recent_encounters: encounters.results,
    encounter_count: encounters.total,
    encounter_next_cursor: encounters.next_cursor,
  };
}

export interface ArchivePersonInput {
  person_id: string;
  idempotency_key?: string;
}

async function setArchived(
  ctx: ToolContext,
  input: ArchivePersonInput,
  tool: string,
  value: string | null
): Promise<Person> {
  const { idempotency_key, ...rest } = input;
  const id = assertId("p", input.person_id);
  return withIdempotency(
    ctx,
    tool,
    idempotency_key,
    rest,
    async () => {
      const result = await ctx.db
        .prepare("UPDATE people SET archived_at = ?, updated_at = ? WHERE id = ?")
        .bind(value, nowIso(ctx.clock), id)
        .run();
      if (result.meta.changes === 0) throw new ToolError("not_found", `no person with id ${id}`);
      return loadPerson(ctx, id);
    },
    id
  );
}

export function archivePerson(ctx: ToolContext, input: ArchivePersonInput): Promise<Person> {
  return setArchived(ctx, input, "archive_person", nowIso(ctx.clock));
}

export function unarchivePerson(ctx: ToolContext, input: ArchivePersonInput): Promise<Person> {
  return setArchived(ctx, input, "unarchive_person", null);
}

export interface DeletePreview {
  person_id: string;
  full_name: string;
  encounter_count: number;
  followup_count: number;
  contact_count: number;
}

/**
 * The preview minus the name. This is what `delete_person` PERSISTS, and
 * therefore what a replay returns; the first call returns the full preview.
 * See `redactForStorage` at the bottom of `deletePerson`.
 */
export type RedactedDeletePreview = Omit<DeletePreview, "full_name">;

export type DeletePersonResult =
  | { status: "confirmation_required"; confirmation_token: string; preview: DeletePreview }
  | { status: "deleted"; deleted: DeletePreview | RedactedDeletePreview };

export interface DeletePersonInput {
  person_id: string;
  confirmation_token?: string;
  idempotency_key?: string;
}

async function deletePreview(ctx: ToolContext, id: string): Promise<DeletePreview> {
  const person = await loadPerson(ctx, id);
  const counts = await ctx.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM person_contacts WHERE person_id = ?1) AS contacts,
         (SELECT COUNT(*) FROM encounters WHERE person_id = ?1) AS encounters,
         (SELECT COUNT(*) FROM followups WHERE person_id = ?1) AS followups`
    )
    .bind(id)
    .first<{ contacts: number; encounters: number; followups: number }>();

  return {
    person_id: id,
    full_name: person.full_name,
    contact_count: counts?.contacts ?? 0,
    encounter_count: counts?.encounters ?? 0,
    followup_count: counts?.followups ?? 0,
  };
}

export async function deletePerson(
  ctx: ToolContext,
  input: DeletePersonInput
): Promise<DeletePersonResult> {
  const id = assertId("p", input.person_id);

  if (input.confirmation_token === undefined) {
    const preview = await deletePreview(ctx, id);
    const confirmation_token = await mintConfirmation(ctx, "delete_person", id, preview);
    return { status: "confirmation_required", confirmation_token, preview };
  }

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "delete_person", idempotency_key, rest, async () => {
      // Deliberately NOT passing `id` as the subjectId here (unlike every other
      // person-scoped write in this module): the batch below purges
      // `idempotency_keys WHERE subject_id = ?` for this same id as part of the
      // erasure, and this very call's own in-flight claim row would be caught by
      // that filter if it carried the same subject_id - deleting itself before
      // the post-run UPDATE can record the response, and turning every retry of
      // a confirmed delete into a fresh (and now-impossible) re-execution against
      // an already-deleted person. Verified empirically while implementing this
      // task: passing `id` here makes the "replays a confirmed delete" test fail.
      // The preview is taken FIRST and handed to redeem, which refuses if it no
      // longer matches what the token was minted from. Encounters logged between
      // the two calls would otherwise be destroyed by a confirmation the human
      // gave against a smaller number.
      const preview = await deletePreview(ctx, id);
      await redeemConfirmation(ctx, "delete_person", id, input.confirmation_token, preview);

      // EVERY CHILD IS DELETED EXPLICITLY. This IS belt-and-braces over the
      // ON DELETE CASCADE declarations in the migrations, and an earlier version
      // of this comment claimed otherwise on a false premise.
      //
      // What that version said: SQLite documents that foreign key actions are
      // unaffected by the recursive_triggers setting, therefore cascaded deletes
      // may not fire the AFTER DELETE triggers maintaining the FTS indexes.
      // The first half is a real sentence in the documentation. The inference is
      // backwards - it means FK actions happen regardless of that setting, not
      // that they skip triggers. Tested 2026-08-24 on SQLite 3.51 with
      // foreign_keys=ON and recursive_triggers=OFF: a cascaded child delete DID
      // remove its FTS row.
      //
      // The explicit deletes stay anyway, for three weaker but honest reasons.
      // D1 runs its own SQLite build inside workerd and the test above was not
      // run there. An explicit delete states the intent where someone reading
      // this function can see it, rather than in a schema three files away. And
      // this tool exists to satisfy erasure requests, where the cost of being
      // wrong is a deleted person's text sitting in a search index indefinitely.
      //
      // The order is children first, parent last, and it is one batch so a
      // partial delete cannot leave a person gone with her encounters indexed.
      // THE TEST IN STEP 5b IS WHAT ACTUALLY GUARANTEES THE OUTCOME - not this
      // comment, and not the cascades either.
      await ctx.db.batch([
        ctx.db.prepare("DELETE FROM encounters WHERE person_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM followups WHERE person_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM person_contacts WHERE person_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM person_links WHERE person_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM person_tags WHERE person_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM person_sources WHERE person_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM people WHERE id = ?").bind(id),

        // THE OPERATIONAL TABLES ARE PART OF THE ERASURE, not housekeeping.
        //
        // `idempotency_keys.response_json` holds a full copy of whatever each
        // write returned, which for most writes is a complete person record -
        // name, notes, contacts, encounters. `confirmations.preview` holds the
        // name and the counts shown in this very delete's preview call. Leaving
        // either behind means `delete_person` removed the person from the tables
        // a reader would look in, and left them in two a reader would not.
        //
        // This tool exists to answer a request to be erased. "We removed most of
        // it" is not an answer to that request.
        ctx.db.prepare("DELETE FROM idempotency_keys WHERE subject_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM confirmations WHERE target_id = ?").bind(id),
      ]);

      return { status: "deleted", deleted: preview };
    },
    // No subjectId - see the comment at the top of this closure.
    undefined,
    undefined,
    // WHAT IS STORED IS NOT WHAT IS RETURNED, and this is the only tool where
    // that is true. `preview.full_name` is the erased person's name, and the
    // batch above cannot scrub this row because it is keyed on a subject_id
    // this call must not set. So the name never reaches the table at all: the
    // caller gets the full preview, `idempotency_keys` gets the counts. A
    // retry still replays rather than re-executing, which is the whole point
    // of the key, and nothing about the person survives it.
    (result) =>
      result.status === "deleted"
        ? {
            status: "deleted",
            deleted: {
              person_id: result.deleted.person_id,
              encounter_count: result.deleted.encounter_count,
              followup_count: result.deleted.followup_count,
              contact_count: result.deleted.contact_count,
            },
          }
        : result
  );
}
