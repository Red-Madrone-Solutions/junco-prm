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
 * How many rows each signal's query may return, applied PER SIGNAL. See the
 * comment on `findDuplicateCandidates` for why it cannot be one cap per table.
 * Inlined into the SQL rather than bound, because SQLite will not accept a
 * parameter in LIMIT on every path and the value is a module constant here.
 */
const PER_SIGNAL_LIMIT = 25;

/**
 * Matches a stored name whose normalized form MAY equal the probe, including
 * the honorific-suffix case ("Ada Lovelace, PhD" against a probe for "Ada
 * Lovelace"). Deliberately a superset - `checkRow` decides. LIKE wildcards in
 * the probe only widen the superset, which the re-check then narrows again.
 */
const LOOSE_NAME_PREDICATE =
  "TRIM(LOWER(full_name)) = ?1 OR TRIM(LOWER(full_name)) LIKE ?1 || ',%'";

interface PersonRow {
  id: string;
  full_name: string;
  organization: string | null;
  email?: string | null;
}

interface RosterRow {
  id: string;
  full_name: string;
  organization: string | null;
  email: string | null;
}

/**
 * Scans people and staged roster entries. Both, always: the whole point is that
 * "add Jane" must see the roster row nobody has promoted yet.
 *
 * ONE BOUNDED QUERY PER SIGNAL, NOT ONE BOUNDED QUERY PER TABLE. An earlier
 * version ran a single `WHERE name = ? OR email = ? OR organization = ?
 * LIMIT 25` per table. SQLite returns whichever 25 rows it reaches first, so on
 * a conference roster the organization arm alone filled the budget and the row
 * that matched by name was never returned - which meant `createPerson` did not
 * refuse and created a durable duplicate whose provenance is unrecoverable.
 * Forty rows sharing an organization was enough. The cap now applies per signal
 * after that signal has selected, so a large organization can never crowd out
 * the name match.
 *
 * THE PREDICATES ARE DELIBERATELY LOOSER THAN THE MATCH. The bound values come
 * from `normalizeName` and `normalizeText`, which apply NFKC, collapse
 * whitespace runs, and strip a known honorific suffix. SQLite's `LOWER()` does
 * none of that, so `LOWER(full_name) = ?` made a staged "Ada Lovelace, PhD"
 * completely invisible to a probe for "Ada Lovelace" - not refused, not even
 * returned as weak evidence, and conference exports carry ", PhD" and ", Jr."
 * routinely. Each query now fetches a superset and `checkRow` below re-applies
 * the real normalizer in JavaScript, which is what the scoring half of this
 * function already did.
 *
 * An expression index on the normalized form was the alternative and it cannot
 * work: no SQL expression reproduces NFKC or the honorific set, so an index
 * over `LOWER(...)` would still miss the case this fixes. What remains
 * unmatched by the SQL prefilter is a stored value differing from its
 * normalized form by NFKC or by an internal whitespace run; those rows are
 * still invisible, and closing that would mean normalizing every row in
 * JavaScript on every probe.
 *
 * Staged rows are not FTS-indexed, by design in the spec, so this is a
 * bounded scan over `roster_entries`. NOTE: it is a FULL SCAN. The
 * LOWER(col) = ? predicates cannot use the plain indexes on full_name and
 * email - SQLite needs an expression index on LOWER(...) for that, and
 * there is none. At the scale this system is built for, a few hundred to a
 * few thousand staged rows, a full scan is sub-millisecond and that is
 * fine. It is stated plainly because an earlier version of this comment
 * credited indexes that do nothing, and the first person to trust it would
 * have been debugging the wrong thing. An FTS index over staged data would
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

  /**
   * Every row from every query goes through every applicable signal, not just
   * the signal whose query returned it. A row the organization query returned
   * that also shares the name must score 2, and it still must if the name
   * query hit its own cap before reaching that row.
   */
  const checkRow = (
    kind: "person" | "roster_entry",
    r: { id: string; full_name: string; organization: string | null; email?: string | null }
  ) => {
    if (kind === "person" ? r.id === opts.excludePersonId : r.id === opts.excludeRosterEntryId) {
      return;
    }
    if (email && r.email && normalizeEmail(r.email) === email) {
      add(kind, r.id, r.full_name, r.organization, "email", "shared email");
    }
    if (normalizeName(r.full_name) === name) {
      add(kind, r.id, r.full_name, r.organization, "name", "shared name");
    }
    if (org && r.organization && normalizeText(r.organization) === org) {
      add(kind, r.id, r.full_name, r.organization, "organization", "shared organization");
    }
  };

  // --- people, by email ---
  if (email) {
    const { results } = await ctx.db
      .prepare(
        `SELECT p.id, p.full_name, p.organization, c.value AS email
           FROM person_contacts c
           JOIN people p ON p.id = c.person_id
          WHERE c.contact_type = 'email' AND c.normalized_value = ?
          LIMIT ${PER_SIGNAL_LIMIT}`
      )
      .bind(email)
      .all<PersonRow>();
    // The normalized_value comparison above IS the email match, so score it
    // directly rather than through checkRow's re-check of `value`.
    for (const r of results) {
      if (r.id === opts.excludePersonId) continue;
      add("person", r.id, r.full_name, r.organization, "email", "shared email");
      if (normalizeName(r.full_name) === name) {
        add("person", r.id, r.full_name, r.organization, "name", "shared name");
      }
      if (org && r.organization && normalizeText(r.organization) === org) {
        add("person", r.id, r.full_name, r.organization, "organization", "shared organization");
      }
    }
  }

  // --- people, by name ---
  {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, full_name, organization
           FROM people
          WHERE archived_at IS NULL AND (${LOOSE_NAME_PREDICATE})
          LIMIT ${PER_SIGNAL_LIMIT}`
      )
      .bind(name)
      .all<PersonRow>();
    for (const r of results) checkRow("person", r);
  }

  // --- people, by organization ---
  if (org) {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, full_name, organization
           FROM people
          WHERE archived_at IS NULL AND TRIM(LOWER(organization)) = ?
          LIMIT ${PER_SIGNAL_LIMIT}`
      )
      .bind(org)
      .all<PersonRow>();
    for (const r of results) checkRow("person", r);
  }

  // --- staged roster entries, the same three signals, one query each ---
  {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, full_name, organization, email
           FROM roster_entries
          WHERE ${LOOSE_NAME_PREDICATE}
          LIMIT ${PER_SIGNAL_LIMIT}`
      )
      .bind(name)
      .all<RosterRow>();
    for (const r of results) checkRow("roster_entry", r);
  }

  if (email) {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, full_name, organization, email
           FROM roster_entries
          WHERE TRIM(LOWER(email)) = ?
          LIMIT ${PER_SIGNAL_LIMIT}`
      )
      .bind(email)
      .all<RosterRow>();
    for (const r of results) checkRow("roster_entry", r);
  }

  if (org) {
    const { results } = await ctx.db
      .prepare(
        `SELECT id, full_name, organization, email
           FROM roster_entries
          WHERE TRIM(LOWER(organization)) = ?
          LIMIT ${PER_SIGNAL_LIMIT}`
      )
      .bind(org)
      .all<RosterRow>();
    for (const r of results) checkRow("roster_entry", r);
  }

  return [...scored.values()].sort((a, b) => b.score - a.score);
}
