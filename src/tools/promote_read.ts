import type { ToolContext } from "../context";
import type { Source } from "../types";

/**
 * Provenance METADATA. `raw_record_snapshot` is never selected.
 *
 * The snapshot is attacker-controlled text - it came off a public roster written
 * by strangers - and `getPerson` is called immediately before most writes
 * against that person. An earlier revision closed the same hole in
 * `search_people` and left it open here, which was worse: search is a browse,
 * and `get_person` is what an agent reads right before it acts.
 *
 * `matches_current` compares the promoted hash against the staged row that
 * carries the same (source_key, external_row_key) today. Three states, not two:
 * true if unchanged, false if the roster row has changed since promotion, and
 * null if there is no staged row at all - purged, or never re-imported. "It
 * changed" and "it is no longer there" call for different next moves, so
 * collapsing null into false would tell the agent the wrong thing.
 *
 * `promoted_at` is not unique - two promotions under the fixed test clock, or
 * two in production inside the same millisecond, land on the same instant -
 * so `ps.id` is a tiebreak. This orders the list deterministically; unlike
 * the staleness baseline in search.ts, no selection decision depends on it.
 */
export async function loadPersonSources(ctx: ToolContext, personId: string): Promise<Source[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT ps.id AS id,
              ps.source_key AS source_key,
              ps.external_row_key AS external_row_key,
              ps.source_label AS source_label,
              ps.source_event AS source_event,
              ps.source_url AS source_url,
              ps.source_captured_at AS source_captured_at,
              ps.content_hash_at_promotion AS content_hash_at_promotion,
              ps.promoted_at AS promoted_at,
              (SELECT CASE WHEN re.content_hash = ps.content_hash_at_promotion THEN 1 ELSE 0 END
                 FROM roster_entries re
                 JOIN roster_sources rs ON rs.id = re.roster_source_id
                WHERE rs.source_key = ps.source_key
                  AND re.external_row_key = ps.external_row_key
                LIMIT 1) AS matches_current
         FROM person_sources ps
        WHERE ps.person_id = ?
        ORDER BY ps.promoted_at, ps.id`
    )
    .bind(personId)
    .all<Omit<Source, "matches_current"> & { matches_current: number | null }>();

  return results.map((r) => ({
    ...r,
    matches_current: r.matches_current === null ? null : r.matches_current === 1,
  }));
}
