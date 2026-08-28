import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import { canonicalJson, normalizeEmail } from "../normalize";
import type { PersonDetail, Source } from "../types";
import {
  findDuplicateCandidates,
  SCORE_PROVENANCE,
  type DuplicateCandidate,
} from "./duplicates";
import { getPerson } from "./people";
import { loadPersonSources } from "./promote_read";

export type { Source } from "../types";
export { loadPersonSources } from "./promote_read";

// DuplicateCandidate and the scoring live in ./duplicates, shared with
// createPerson. The spec says both tools run "the same duplicate check," and
// two implementations of the same check drift within a release.
export type { DuplicateCandidate } from "./duplicates";

interface EntryRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  organization: string | null;
  email: string | null;
  role: string | null;
  source_url: string;
  source_captured_at: string;
  raw_record: string;
  content_hash: string;
  source_key: string;
  source_label: string;
  source_event: string | null;
  external_row_key: string;
}

/** What phase one shows. `raw_record` is not in it, ever. */
export type EntryPreview = Omit<EntryRow, "raw_record">;

export type PromoteResult =
  | {
      status: "candidates";
      roster_entry_id: string;
      /** Present this back on the commit call. See `expected_content_hash`. */
      content_hash: string;
      preview: EntryPreview;
      candidates: DuplicateCandidate[];
    }
  | { status: "promoted"; person: PersonDetail; linked_existing: boolean };

export interface PromoteInput {
  roster_entry_id: string;
  link_to_person_id?: string;
  create_new?: boolean;
  /**
   * The `content_hash` phase one returned. Optional, and checked when present:
   * if the roster row changed or was purged between the two calls, the commit
   * is refused rather than promoting a person from data the caller never
   * inspected.
   *
   * Deliberately NOT a confirmation token. Promotion's worst outcome is a
   * duplicate person, which is recoverable and which the provenance override
   * below already prevents in the case the system can see. A mandatory round
   * trip on the highest-frequency conference action would cost more than it
   * saves.
   */
  expected_content_hash?: string;
  idempotency_key?: string;
}

async function loadEntry(ctx: ToolContext, id: string): Promise<EntryRow> {
  const row = await ctx.db
    .prepare(
      `SELECT re.id AS id, re.full_name AS full_name, re.preferred_name AS preferred_name,
              re.job_title AS job_title, re.organization AS organization, re.email AS email,
              re.role AS role, re.source_url AS source_url,
              re.source_captured_at AS source_captured_at, re.raw_record AS raw_record,
              re.content_hash AS content_hash,
              re.external_row_key AS external_row_key, rs.source_key AS source_key,
              rs.label AS source_label, rs.event AS source_event
       FROM roster_entries re
       JOIN roster_sources rs ON rs.id = re.roster_source_id
       WHERE re.id = ?`
    )
    .bind(id)
    .first<EntryRow>();
  if (!row) throw new ToolError("not_found", `no roster entry with id ${id}`);
  return row;
}

/**
 * The shared check from Task 6, plus the one signal only promotion has.
 *
 * An existing `person_sources` row carrying this roster's `source_key` and this
 * row's `external_row_key` is the strongest evidence there is: it means this
 * exact row was promoted before, possibly under an earlier import of the same
 * roster. `findDuplicateCandidates` cannot know that, because it takes a probe
 * rather than a roster row.
 */
async function candidatesFor(ctx: ToolContext, entry: EntryRow): Promise<DuplicateCandidate[]> {
  const found = await findDuplicateCandidates(
    ctx,
    {
      full_name: entry.full_name,
      organization: entry.organization ?? undefined,
      email: entry.email ?? undefined,
    },
    // Not itself. A roster row is always its own strongest name match.
    { excludeRosterEntryId: entry.id }
  );

  const prior = await ctx.db
    .prepare(
      `SELECT p.id AS id, p.full_name AS full_name, p.organization AS organization
         FROM person_sources ps
         JOIN people p ON p.id = ps.person_id
        WHERE ps.source_key = ? AND ps.external_row_key = ?`
    )
    .bind(entry.source_key, entry.external_row_key)
    .first<{ id: string; full_name: string; organization: string | null }>();

  if (prior) {
    const existing = found.find((c) => c.record_kind === "person" && c.id === prior.id);
    if (existing) {
      existing.evidence.unshift("promoted from this exact roster row before");
      existing.score += SCORE_PROVENANCE;
    } else {
      found.unshift({
        record_kind: "person",
        id: prior.id,
        full_name: prior.full_name,
        organization: prior.organization,
        evidence: ["promoted from this exact roster row before"],
        score: SCORE_PROVENANCE,
      });
    }
  }

  return found.sort((a, b) => b.score - a.score);
}

export async function promoteRosterEntry(
  ctx: ToolContext,
  input: PromoteInput
): Promise<PromoteResult> {
  const entryId = assertId("re", input.roster_entry_id);
  const entry = await loadEntry(ctx, entryId);

  const wantsLink = input.link_to_person_id !== undefined;
  const wantsNew = input.create_new === true;

  if (wantsLink && wantsNew) {
    throw new ToolError(
      "invalid_input",
      "pass either link_to_person_id or create_new, not both"
    );
  }

  // Phase one writes nothing. `raw_record` is destructured out and dropped:
  // it is untrusted roster text and this result goes into a model's context
  // immediately before a write decision about the person it describes.
  if (!wantsLink && !wantsNew) {
    const { raw_record, ...preview } = entry;
    return {
      status: "candidates",
      roster_entry_id: entryId,
      content_hash: entry.content_hash,
      preview,
      candidates: await candidatesFor(ctx, entry),
    };
  }

  // The commit sees the row as it is NOW. If it moved between the two calls,
  // refuse rather than promote a person from data the caller never inspected.
  if (
    typeof input.expected_content_hash === "string" &&
    input.expected_content_hash !== entry.content_hash
  ) {
    throw new ToolError(
      "conflict",
      "this roster row has changed since the preview",
      `call promote_roster_entry with roster_entry_id ${entryId} again to see the current row and its candidates`
    );
  }

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "promote_roster_entry", idempotency_key, rest, async () => {
    // PRIOR PROMOTION IS READ FROM DURABLE PROVENANCE, and the check runs
    // BEFORE the caller's intent is honored.
    //
    // The previous draft asked `person_roster_entries` whether this `re_` id
    // had been promoted. A re-import can give the same logical row a NEW `re_`
    // id, so that question was "was this row object promoted" when the question
    // that matters is "was this person from this source promoted." The pair
    // (source_key, external_row_key) survives a purge, a re-import, and a year.
    //
    // An exact match returns the existing person and creates nothing, EVEN WHEN
    // the call said create_new: true. Tolerating duplicates the system cannot
    // detect is a considered position; creating one the system is already
    // holding provenance for is a bug, and an agent that skipped straight to
    // phase two should not be able to cause it.
    const already = await ctx.db
      .prepare(
        "SELECT person_id FROM person_sources WHERE source_key = ? AND external_row_key = ?"
      )
      .bind(entry.source_key, entry.external_row_key)
      .first<{ person_id: string }>();

    if (already) {
      // THE OVERRIDE DEPENDS ON WHAT THE CALLER ACTUALLY ASKED FOR, and an
      // earlier version of this code did not distinguish the two.
      //
      // `create_new: true` asked for "a person" from this row. Provenance
      // already exists, so returning the person it points at is exactly right -
      // the spec wants this override precisely so an agent that skipped phase
      // one cannot create a duplicate the system is already holding provenance
      // for.
      //
      // `link_to_person_id: X` asked for "THIS person". Returning a different
      // person Y under a success status, with linked_existing: true, is the
      // failure this whole design is organized against - a write against the
      // wrong person, reported as if it went where the caller meant. The
      // previous draft did that, and its test was titled "refuses to promote
      // one roster entry onto a second person" while asserting that it does not
      // refuse.
      if (wantsLink && input.link_to_person_id !== already.person_id) {
        throw new ToolError(
          "conflict",
          `roster entry ${entryId} was already promoted to a different person`,
          `call get_person with person_id ${already.person_id} to see who this roster row belongs to`,
          { promoted_person_id: already.person_id }
        );
      }

      return {
        status: "promoted" as const,
        person: await getPerson(ctx, { person_id: already.person_id }),
        linked_existing: true,
      };
    }

    const at = nowIso(ctx.clock);

    // The snapshot is canonicalized so its hash is reproducible, and stored
    // alongside that hash. They do different jobs: the hash detects that the
    // roster row has changed since promotion, and the snapshot is the only
    // thing that can still show what was captured once the staged row is
    // purged. A hash alone is worthless after the source disappears, which is
    // exactly when provenance matters.
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.raw_record);
    } catch {
      parsed = { raw: entry.raw_record };
    }
    const snapshot = canonicalJson(parsed);
    const rawHash = entry.content_hash;

    // The bump lives here, in the shared statement array, so it covers both
    // the link path and the create path below with one definition.
    //
    // Only the link path needs it: get_person returns person_sources, so
    // linking an existing person changes what get_person returns for them
    // without this. The create path inserts the person row in the same
    // operation with fresh created_at/updated_at values (`at`, above), so a
    // bump there writes the value the row already has - harmless, not a
    // special case to avoid.
    const provenance = (personId: string) => [
      ctx.db
        .prepare(
          `INSERT INTO person_sources
             (id, person_id, source_key, external_row_key, source_label, source_event,
              source_url, source_captured_at, raw_record_snapshot, content_hash_at_promotion, promoted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          newId("ps"),
          personId,
          entry.source_key,
          entry.external_row_key,
          // The label and event as they read at promotion time, so provenance
          // survives the source being relabelled later.
          entry.source_label,
          entry.source_event,
          entry.source_url,
          entry.source_captured_at,
          snapshot,
          rawHash,
          at
        ),
      ctx.db.prepare("UPDATE people SET updated_at = ? WHERE id = ?").bind(at, personId),
    ];

    if (wantsLink) {
      const personId = assertId("p", input.link_to_person_id);
      const exists = await ctx.db
        .prepare("SELECT id FROM people WHERE id = ?")
        .bind(personId)
        .first<{ id: string }>();
      if (!exists) throw new ToolError("not_found", `no person with id ${personId}`);

      // THE LINK PATH LOSES RACES TOO, and it is the branch where losing one
      // does the most damage. Two concurrent commits on the same
      // (source_key, external_row_key) - one create_new, one link_to_person_id -
      // both read no prior provenance at the `already` check above. The create
      // path recovers below. Without the same recovery here, the link path
      // surfaces a raw D1 unique-constraint error: no code from the closed set
      // of seven, no reason in this tool's vocabulary, and no corrective next
      // call for a caller that is a model and will otherwise guess.
      //
      // An earlier draft put this recovery in the create path's catch instead,
      // where `wantsLink` is necessarily false because this branch returns
      // first, so it could never fire.
      try {
        await ctx.db.batch(provenance(personId));
      } catch (e) {
        const winner = await ctx.db
          .prepare(
            "SELECT person_id FROM person_sources WHERE source_key = ? AND external_row_key = ?"
          )
          .bind(entry.source_key, entry.external_row_key)
          .first<{ person_id: string }>();

        // Only a lost race explains a winner being there now. Anything else is
        // a real failure and must not be dressed up as a successful promotion.
        if (!winner) throw e;

        // Someone other than the person this call named got the roster row.
        // This is the same refusal the `already` branch makes, reached a few
        // milliseconds later, and it carries the same code and the same next
        // call so the caller cannot tell the two timings apart.
        if (winner.person_id !== personId) {
          throw new ToolError(
            "conflict",
            `roster entry ${entryId} was promoted to a different person while this call was in flight`,
            `call get_person with person_id ${winner.person_id} to see who this roster row belongs to`,
            { promoted_person_id: winner.person_id }
          );
        }

        // The winner IS the person this call named, so the caller's intent was
        // satisfied by whoever got there first. Fall through and return them,
        // which is the same answer the sequential retry gives.
      }

      return {
        status: "promoted" as const,
        person: await getPerson(ctx, { person_id: personId }),
        linked_existing: true,
      };
    }

    // Creating a person, its email, and its provenance is one transaction. The id is
    // minted here rather than returned by a helper so every statement can be batched.
    const personId = newId("p");
    const statements = [
      ctx.db
        .prepare(
          `INSERT INTO people (id, full_name, preferred_name, job_title, organization, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          personId,
          entry.full_name,
          entry.preferred_name,
          entry.job_title,
          entry.organization,
          at,
          at
        ),
      ...(entry.email
        ? [
            ctx.db
              .prepare(
                `INSERT INTO person_contacts
                   (id, person_id, contact_type, value, normalized_value, label, created_at)
                 VALUES (?, ?, 'email', ?, ?, NULL, ?)
                 ON CONFLICT (person_id, contact_type, normalized_value) DO NOTHING`
              )
              .bind(newId("pc"), personId, entry.email, normalizeEmail(entry.email), at),
          ]
        : []),
      ...provenance(personId),
    ];

    // THE UNIQUE CONSTRAINT IS ALLOWED TO WIN, and the previous draft's
    // ON CONFLICT DO NOTHING quietly prevented that.
    //
    // Two concurrent create_new calls can both read no prior provenance. The
    // first commits. With DO NOTHING the second's provenance insert is silently
    // skipped while its person insert succeeds, so the batch commits and the
    // tool returns an ORPHAN PERSON reported as successfully promoted - a
    // durable record with no origin, and no way to notice.
    //
    // Letting the violation abort the batch rolls back the person too. We then
    // load whoever won and return them, which is the same answer the sequential
    // case gives.
    try {
      await ctx.db.batch(statements);
    } catch (e) {
      const winner = await ctx.db
        .prepare(
          "SELECT person_id FROM person_sources WHERE source_key = ? AND external_row_key = ?"
        )
        .bind(entry.source_key, entry.external_row_key)
        .first<{ person_id: string }>();

      // Only a lost race explains a winner being there now. Anything else is a
      // real failure and must not be dressed up as a successful promotion.
      if (!winner) throw e;

      // No `wantsLink` check here. The link branch above returns before this
      // point, so `wantsLink` is necessarily false and a copy of that refusal
      // in this catch could never fire. It lives in the link branch instead,
      // which is the branch that can actually reach it.
      return {
        status: "promoted" as const,
        person: await getPerson(ctx, { person_id: winner.person_id }),
        linked_existing: true,
      };
    }

    return {
      status: "promoted" as const,
      person: await getPerson(ctx, { person_id: personId }),
      linked_existing: false,
    };
  },
  // No subjectId, because this tool does not know which person it is about
  // until it has either created one or resolved the link - the same situation
  // update_encounter and delete_encounter are in.
  undefined,
  // Phase one returns candidates and is about nobody, so it records no subject.
  // Phase two returns the person it produced, and the stored response is a full
  // PersonDetail - without this the copy sits under subject_id NULL forever and
  // delete_person's scrub can never reach it by id.
  (result) => (result.status === "promoted" ? result.person.id : undefined));
}
