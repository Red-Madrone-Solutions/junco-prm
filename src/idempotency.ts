import type { ToolContext } from "./context";
import { ToolError } from "./errors";
import { canonicalJson, sha256Hex } from "./normalize";
import { nowIso } from "./time";

export async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

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
   * For a write that MINTS the id it is about - `create_person` is the only
   * one - there is no `person_id` to pass as `subjectId` above, because it
   * does not exist until `run()` returns. Without a way to record it after
   * the fact, `create_person`'s stored response - a full copy of the person,
   * same as any other write's - sits under subject_id NULL forever, and
   * `delete_person`'s scrub can never reach it by id.
   *
   * Called once, after `run()` succeeds, with its result. Only the
   * newly-minted case needs this: everything else already has its subject
   * before the call and passes it as `subjectId` instead.
   */
  subjectFromResult?: (result: T) => string | undefined
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
    if (existing.response_json === null) {
      throw new ToolError(
        "conflict",
        `idempotency_key "${key}" is still in flight for ${tool}; retry once the first call returns`
      );
    }
    return JSON.parse(existing.response_json) as T;
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
    .bind(JSON.stringify(result), nowIso(ctx.clock), finalSubject, scoped)
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
