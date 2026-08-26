import type { ToolContext } from "./context";
import { ToolError } from "./errors";
import { canonicalJson, sha256Hex } from "./normalize";
import { nowIso } from "./time";

export async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/**
 * How long a claim with no response can sit before another call may take it
 * over. A Worker request cannot outlive its own invocation, so a claim older
 * than this belongs to an isolate that is gone.
 *
 * NOT configurable on purpose. An operator who tunes this down turns a safety
 * margin into a double-write.
 */
export const IN_FLIGHT_RECLAIM_MS = 15 * 60 * 1000;

/**
 * How long a row survives after it completes. `response_json` holds whatever
 * the tool returned, which for most writes is a full person record, so this
 * table is a slow shadow copy of the PRM if nothing prunes it.
 */
export const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounded so a long-neglected instance cannot spend an unbounded delete on one request. */
const PRUNE_BATCH = 100;

export async function withIdempotency<T>(
  ctx: ToolContext,
  tool: string,
  key: string | undefined,
  input: unknown,
  run: () => Promise<T>,
  /**
   * The person this write is about, when there is one.
   *
   * Recorded so `delete_person` can scrub the stored responses along with the
   * person. `response_json` holds whatever the tool returned, which for most
   * writes is a full person record, so without this the table is a shadow copy
   * of the PRM that erasure cannot reach.
   *
   * Every tool taking a `person_id` passes it. Tools that are not about one
   * person - import, finalize, purge - pass nothing.
   */
  subjectId?: string,
  /**
   * For a write that does not have its subject's `person_id` in hand before
   * `run()` executes, either because it MINTS the id (`create_person`) or
   * because its input names a child row (`update_encounter`,
   * `delete_encounter`) and the parent is only known once that row is
   * loaded. Without a way to record it after the fact, the stored response -
   * a full copy of the person or encounter, same as any other write's - sits
   * under subject_id NULL forever, and `delete_person`'s scrub can never
   * reach it by id.
   *
   * Called once, after `run()` succeeds, with its result. Everything else
   * already has its subject before the call and passes it as `subjectId`
   * instead.
   */
  subjectFromResult?: (result: T) => string | undefined,
  /**
   * What to persist in `response_json` INSTEAD of the value returned to the
   * caller, for the one write whose result must not be stored as it stands.
   *
   * `delete_person` answers an erasure request and its result carries the
   * erased person's name. Storing it verbatim leaves that name in an
   * operational table under a NULL subject_id, where the delete's own scrub -
   * which matches on subject_id - cannot reach it. It cannot pass its own id as
   * the subject either; see the comment in `deletePerson` for why that makes
   * the row delete itself before the response is recorded. So it redacts what
   * it stores instead, and a replay returns the redacted form, which is the
   * only form that can honestly survive the erasure.
   *
   * Every other write stores what it returned.
   */
  redactForStorage?: (result: T) => unknown
): Promise<T> {
  if (!key) return run();

  const scoped = `${tool}:${key}`;
  const requestHash = await hashJson(input);
  const at = nowIso(ctx.clock);

  // Claim the key first. The insert is the lock: whichever caller wins it runs the
  // operation, and everyone else sees the claim rather than an empty table.
  const claim = await ctx.db
    .prepare(
      `INSERT INTO idempotency_keys (key, tool, subject_id, request_hash, response_json, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT (key) DO NOTHING`
    )
    .bind(scoped, tool, subjectId ?? null, requestHash, at)
    .run();

  if (claim.meta.changes === 0) {
    const existing = await ctx.db
      .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?")
      .bind(scoped)
      .first<{ request_hash: string; response_json: string | null }>();

    if (!existing) {
      throw new ToolError("conflict", `idempotency_key "${key}" is contended; retry`);
    }
    if (existing.request_hash !== requestHash) {
      throw new ToolError(
        "conflict",
        `idempotency_key "${key}" was already used by ${tool} with different arguments`
      );
    }
    if (existing.response_json !== null) {
      return JSON.parse(existing.response_json) as T;
    }

    // THE RECLAIM. Take the claim over only if no isolate could still hold it.
    // The UPDATE is the lock: its WHERE re-checks both the NULL response and the
    // age, so two concurrent retries cannot both win it.
    const cutoff = new Date(Date.parse(at) - IN_FLIGHT_RECLAIM_MS).toISOString();
    const reclaimed = await ctx.db
      .prepare(
        `UPDATE idempotency_keys SET created_at = ?
          WHERE key = ? AND response_json IS NULL AND created_at < ?`
      )
      .bind(at, scoped, cutoff)
      .run();

    if (reclaimed.meta.changes === 0) {
      throw new ToolError(
        "conflict",
        `idempotency_key "${key}" is still in flight for ${tool}; retry once the first call returns`
      );
    }

    // A reclaim that happens silently is worse than the wedge it fixes: the
    // operation is about to run a second time, and if the first one committed
    // before its isolate died, this is the moment a duplicate is created.
    //
    // Not routed through src/log.ts: this module is plan 1 code with no
    // Worker dependency, and importing plan 2's logger would invert the
    // dependency the whole plan rests on. The console-guard test carries a
    // matching, narrowly-scoped exception for exactly this line - see the
    // comment there. No key, no input, no subject: the key itself is
    // caller-chosen text a roster could have supplied.
    console.log(JSON.stringify({ event: "idempotency_claim_reclaimed", tool }));
    // Fall through to run(). Do NOT return.
  }

  let result: T;
  try {
    result = await run();
  } catch (error) {
    // Release the claim so a corrected retry with the same key is possible.
    await ctx.db.prepare("DELETE FROM idempotency_keys WHERE key = ?").bind(scoped).run();
    throw error;
  }

  const finalSubject = subjectId ?? subjectFromResult?.(result) ?? null;
  await ctx.db
    .prepare(
      "UPDATE idempotency_keys SET response_json = ?, completed_at = ?, subject_id = ? WHERE key = ?"
    )
    .bind(
      JSON.stringify(redactForStorage ? redactForStorage(result) : result),
      nowIso(ctx.clock),
      finalSubject,
      scoped
    )
    .run();

  // Opportunistic, bounded, and expressed as a subquery because DELETE ... LIMIT
  // needs a SQLite built with SQLITE_ENABLE_UPDATE_DELETE_LIMIT and D1's build is
  // not documented to have it.
  //
  // Two shapes, and missing the second leaves the wedge half-fixed: rows that
  // COMPLETED long ago, and claims nobody ever retried, which would otherwise
  // never be reclaimed and never removed.
  const staleBefore = new Date(Date.parse(at) - IDEMPOTENCY_RETENTION_MS).toISOString();
  await ctx.db
    .prepare(
      `DELETE FROM idempotency_keys WHERE key IN (
         SELECT key FROM idempotency_keys
          WHERE (completed_at IS NOT NULL AND completed_at < ?1)
             OR (response_json IS NULL AND created_at < ?1)
          LIMIT ?2
       )`
    )
    .bind(staleBefore, PRUNE_BATCH)
    .run();

  return result;
}

/**
 * Record that a chunk committed. Written inside the same batch as the chunk's
 * writes in Task 12b, so a receipt cannot exist for a chunk that did not land
 * and a chunk cannot land without a receipt.
 */
export async function recordChunkReceipt(
  ctx: ToolContext,
  runId: string,
  offset: number,
  rowCount: number,
  payloadHash: string,
  result: unknown
): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO import_chunk_receipts
         (run_id, offset_value, row_count, payload_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(runId, offset, rowCount, payloadHash, JSON.stringify(result), nowIso(ctx.clock))
    .run();
}

/**
 * The replay lookup. Task 12b calls this BEFORE the offset check, and the order
 * is not incidental: a retried chunk presents an offset the run has already
 * passed, so checking the offset first makes the mechanism that exists to make
 * retries safe unreachable behind the rule it exists to soften, and wedges the
 * run at an offset the caller cannot discover.
 *
 * Returns the stored result for a matching retry, null when there is no receipt
 * at this offset, and throws `conflict` when a different payload is presented
 * at an offset that has already been consumed.
 */
export async function findChunkReceipt(
  ctx: ToolContext,
  runId: string,
  offset: number,
  payloadHash: string
): Promise<unknown | null> {
  const row = await ctx.db
    .prepare(
      "SELECT payload_hash, result_json FROM import_chunk_receipts WHERE run_id = ? AND offset_value = ?"
    )
    .bind(runId, offset)
    .first<{ payload_hash: string; result_json: string }>();

  if (!row) return null;
  if (row.payload_hash !== payloadHash) {
    throw new ToolError(
      "conflict",
      `offset ${offset} was already committed with different rows`,
      "call import_roster again from the run's next_offset with the rows that follow"
    );
  }
  return JSON.parse(row.result_json);
}
