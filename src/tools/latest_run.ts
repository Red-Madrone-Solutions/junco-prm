/**
 * ONE COPY, USED BY THREE QUERIES. `search_people`, `list_roster_sources` and
 * `get_roster_entry` each need the same thing: the newest committed import run
 * per roster source, which is the baseline every staleness answer is measured
 * against.
 *
 * It was three byte-identical copies. The usual argument for keeping copies
 * independent - that they can diverge as their queries diverge - did not apply
 * here: they never diverged, they encode one correctness property, that property
 * was wrong in all three at once until it was fixed, and only the `search.ts`
 * copy is reached by any test. Reverting the tiebreak in both `roster_admin.ts`
 * copies while leaving `search.ts` correct passed the entire suite, five runs
 * out of five. So two of the three could silently regress.
 *
 * EXACTLY ONE ROW PER SOURCE, and the obvious formulation is wrong.
 *
 * The tiebreak is rowid DESC, not id DESC. `import_runs.id` is "ir_" followed
 * by `crypto.randomUUID()` (src/ids.ts), so ordering by it breaks a tie between
 * two runs finished in the same instant by comparing two random UUIDs -
 * effectively a coin flip over which run is the staleness baseline.
 * `import_runs` has a TEXT PRIMARY KEY and no WITHOUT ROWID clause, so it
 * carries an implicit rowid that increases with insertion order, which is the
 * chronological ordering this tiebreak means. This is a single-query ORDER BY,
 * not a stored or FTS-indexed value, so it is not the rowid hazard the design
 * doc's Global Constraints warn about (VACUUM renumbering rowids stored in an
 * external-content FTS index) - nothing here persists a rowid anywhere.
 *
 * Text rather than a view: D1 applies `migrations/`, and adding a view would be
 * a migration whose only purpose is deduplicating a string. The constant is
 * inlined into each query with a template literal, so a caller still writes its
 * own SELECT and its own joins against `latest`.
 */
export const LATEST_COMMITTED_RUN_CTE = `latest AS (
         SELECT roster_source_id, run_id, finished_at FROM (
           SELECT roster_source_id, id AS run_id, finished_at,
                  ROW_NUMBER() OVER (PARTITION BY roster_source_id
                                     ORDER BY finished_at DESC, rowid DESC) AS rn
             FROM import_runs WHERE status = 'committed'
         ) WHERE rn = 1
       )`;
