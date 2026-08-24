import type { ToolContext } from "../context";
import { normalizeEmail, normalizeName, normalizeText } from "../normalize";

export interface DuplicateCandidate {
  /** Which array of `search_people` this record would have come from. */
  record_kind: "person" | "roster_entry";
  id: string;
  full_name: string;
  organization: string | null;
  /** Human-readable, one string per matched signal, for the agent to read. */
  evidence: string[];
  score: number;
}

/**
 * At or above this, `createPerson` refuses. Below it, the candidate is still
 * returned as evidence but nothing is blocked.
 *
 * TWO IS DELIBERATE AND THE ARITHMETIC IS THE WHOLE POINT. A bare name scores 1
 * and a bare organization scores 1, so neither refuses on its own. A name AND an
 * organization on the same record sum to 2 and do refuse. An email scores 2 by
 * itself, because it is the closest thing to an identity a person carries.
 *
 * An earlier version of this file set the threshold to 3 while name and
 * organization each scored 1. That is 2, so the check could never fire for
 * anything except an email, and six of Task 6's tests asserted a refusal the
 * code could not produce. It is worth stating because the failure was silent in
 * exactly the wrong direction: the duplicate check appeared to exist, was
 * documented at length, and did nothing.
 *
 * If you change any value in SCORE, re-derive this threshold by hand and check
 * it against Task 6's tests. There is no test that asserts the arithmetic
 * itself, and the review that caught this was reading, not running.
 */
export const STRONG_MATCH = 2;

/**
 * The one signal only `promoteRosterEntry` can produce: an existing
 * `person_sources` row carrying this roster's source key and this row's
 * external row key means this exact row was promoted before. It outscores
 * everything else because it is not evidence of similarity, it is a record of a
 * decision already made.
 */
export const SCORE_PROVENANCE = 5;

/** Exported individually so Task 6's tests can assert the arithmetic holds. */
export const SCORE_EMAIL = 2;
export const SCORE_NAME = 1;
export const SCORE_ORGANIZATION = 1;

const SCORE = {
  email: SCORE_EMAIL,
  name: SCORE_NAME,
  organization: SCORE_ORGANIZATION,
  provenance: SCORE_PROVENANCE,
} as const;

// Sanity check on the arithmetic above, because getting it wrong is silent and
// disables the whole check. Runs once at module load, costs nothing.
if (SCORE.name + SCORE.organization < STRONG_MATCH || SCORE.email < STRONG_MATCH) {
  throw new Error(
    "duplicates.ts: SCORE and STRONG_MATCH disagree - a name plus an organization, " +
      "and an email alone, must each reach STRONG_MATCH"
  );
}

/**
 * Scans people and staged roster entries. Both, always: the whole point is that
 * "add Jane" must see the roster row nobody has promoted yet.
 *
 * Staged rows are not FTS-indexed, by design in the spec, so this is a bounded
 * LIKE scan over `roster_entries`. At the scale this system is built for - a few
 * hundred to a few thousand staged rows, with indexes on `full_name` and `email`
 * from Task 3 - that is fast enough, and an FTS index over staged data would
 * fire triggers on every imported row, spending exactly the CPU budget the
 * import protocol is fighting for.
 *
 * `raw_record` is never selected. It is untrusted text and this result goes
 * straight into a model's context immediately before a write decision.
 */
export async function findDuplicateCandidates(
  ctx: ToolContext,
  probe: { full_name: string; organization?: string; email?: string },
  opts: { excludeRosterEntryId?: string; excludePersonId?: string } = {}
): Promise<DuplicateCandidate[]> {
  const name = normalizeName(probe.full_name);
  const org = probe.organization ? normalizeText(probe.organization) : null;
  const email = probe.email ? normalizeEmail(probe.email) : null;

  const scored = new Map<string, DuplicateCandidate>();

  const add = (
    kind: "person" | "roster_entry",
    id: string,
    fullName: string,
    organization: string | null,
    signal: keyof typeof SCORE,
    label: string
  ) => {
    const key = `${kind}:${id}`;
    const existing = scored.get(key);
    if (existing) {
      if (existing.evidence.includes(label)) return;
      existing.evidence.push(label);
      existing.score += SCORE[signal];
      return;
    }
    scored.set(key, {
      record_kind: kind,
      id,
      full_name: fullName,
      organization,
      evidence: [label],
      score: SCORE[signal],
    });
  };

  // --- people, by email ---
  if (email) {
    const { results } = await ctx.db
      .prepare(
        `SELECT p.id, p.full_name, p.organization
           FROM person_contacts c
           JOIN people p ON p.id = c.person_id
          WHERE c.contact_type = 'email' AND c.normalized_value = ?`
      )
      .bind(email)
      .all<{ id: string; full_name: string; organization: string | null }>();
    for (const r of results) {
      if (r.id === opts.excludePersonId) continue;
      add("person", r.id, r.full_name, r.organization, "email", "shared email");
    }
  }

  // --- people, by name and organization ---
  {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, full_name, organization
           FROM people
          WHERE archived_at IS NULL
            AND (LOWER(full_name) = ? OR (? IS NOT NULL AND LOWER(organization) = ?))
          LIMIT 25`
      )
      .bind(name, org, org)
      .all<{ id: string; full_name: string; organization: string | null }>();
    for (const r of results) {
      if (r.id === opts.excludePersonId) continue;
      if (normalizeName(r.full_name) === name) {
        add("person", r.id, r.full_name, r.organization, "name", "shared name");
      }
      if (org && r.organization && normalizeText(r.organization) === org) {
        add("person", r.id, r.full_name, r.organization, "organization", "shared organization");
      }
    }
  }

  // --- staged roster entries, same two signals ---
  {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, full_name, organization, email
           FROM roster_entries
          WHERE LOWER(full_name) = ?
             OR (? IS NOT NULL AND LOWER(email) = ?)
             OR (? IS NOT NULL AND LOWER(organization) = ?)
          LIMIT 25`
      )
      .bind(name, email, email, org, org)
      .all<{ id: string; full_name: string; organization: string | null; email: string | null }>();
    for (const r of results) {
      if (r.id === opts.excludeRosterEntryId) continue;
      if (email && r.email && normalizeEmail(r.email) === email) {
        add("roster_entry", r.id, r.full_name, r.organization, "email", "shared email");
      }
      if (normalizeName(r.full_name) === name) {
        add("roster_entry", r.id, r.full_name, r.organization, "name", "shared name");
      }
      if (org && r.organization && normalizeText(r.organization) === org) {
        add("roster_entry", r.id, r.full_name, r.organization, "organization", "shared organization");
      }
    }
  }

  return [...scored.values()].sort((a, b) => b.score - a.score);
}
