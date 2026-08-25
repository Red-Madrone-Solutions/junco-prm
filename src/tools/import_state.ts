import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
// `prepareRow` is the only consumer of these, and every one of them is a pinned
// rule. `hashJson` from ../idempotency is deliberately NOT imported here:
// identity and change detection hash a canonicalized subset of the row, not an
// arbitrary value, and routing them through a general-purpose helper is how the
// two hashes drift apart again.
import {
  contentHash,
  externalRowKey,
  normalizeEmail,
  normalizeName,
  normalizeText,
  type NormalizedRow,
} from "../normalize";
import { nowIso } from "../time";

/**
 * Rows accepted per call.
 *
 * MEASURED 2026-08-24 on a free Cloudflare account - see docs/MEASUREMENTS.md.
 * The value is unchanged from the placeholder that preceded it, and the reason
 * for it is completely different. That is worth reading before changing it.
 *
 * NEITHER PLATFORM LIMIT THIS CONSTANT WAS BUILT AROUND ACTUALLY BINDS.
 *
 *   - A db.batch() does NOT spend one query per statement. 500 statements
 *     completed in 3 ms of CPU on a free plan. Two earlier drafts derived this
 *     cap from a 50-query-per-invocation budget; that arithmetic was wrong.
 *   - The free-plan CPU ceiling is NOT 10 ms. A 5,000-row invocation doing
 *     exactly this work spent 163 ms and completed, with no ceiling found. A
 *     row costs about 0.033 ms, so a 150-row chunk costs roughly 5 ms.
 *
 * WHAT BOUNDS IT NOW IS THE MODEL, NOT THE RUNTIME. A chunk is roster rows a
 * language model has to emit as JSON in a single tool call, at roughly 50 to
 * 100 tokens per row. 150 rows is 7,500 to 15,000 tokens of tool input: a
 * reasonable amount to ask for in one call, and to re-emit if that call has to
 * be retried. 500 rows would be 25,000 to 50,000, which is not.
 *
 * So anyone raising this number should be arguing about tool call size and
 * retry cost. Cloudflare is no longer the reason for it.
 */
export const IMPORT_BATCH_LIMIT = 150;

/** 16 bound columns per row against D1's 100-parameter statement cap. */
export const UPSERT_ROWS_PER_STATEMENT = 6;

/** Key pre-checks bind the source id plus this many keys, staying under 100. */
export const KEY_LOOKUP_CHUNK = 99;

export interface RosterRow {
  external_row_key?: string;
  full_name: string;
  preferred_name?: string;
  job_title?: string;
  organization?: string;
  email?: string;
  role?: string;
  raw?: unknown;
}

export interface ImportRosterInput {
  source_key: string;
  label: string;
  source_url: string;
  format: "csv" | "json" | "text";
  /** This call's chunk only, never the whole roster. At most IMPORT_BATCH_LIMIT rows. */
  rows: RosterRow[];
  /** Required on the first call of a run. The total the whole run will send. */
  expected_total?: number;
  event?: string;
  run_id?: string;
  /** Required on a continuation. Must equal the run's next_offset exactly. */
  offset?: number;
  idempotency_key?: string;
}

export interface RunState {
  run_id: string;
  roster_source_id: string;
  expected_total: number;
  next_offset: number;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];

  return body
    .filter((cells) => cells.some((c) => c.trim() !== ""))
    .map((cells) => {
      const record: Record<string, string> = {};
      header.forEach((name, index) => {
        record[name.trim()] = (cells[index] ?? "").trim();
      });
      return record;
    });
}

export interface NormalizedRosterRow {
  /** Identity. Stable across edits to fields outside the identity subset. */
  key: string;
  /** Change detection. Moves whenever ANY field moves. */
  content_hash: string;
  /** The row as it will be stored, trimmed but not folded. */
  fields: RosterRow;
}

/**
 * Applies the pinned rules and computes BOTH hashes.
 *
 * The two values are computed from different inputs on purpose. `key` comes
 * from the identity subset - the source's own row id, else the normalized
 * email, else a digest of normalized name plus organization. `content_hash`
 * comes from the whole normalized row. A single value cannot do both jobs: used
 * as identity, a whole-row hash makes an edited row a new row, so the edit is
 * undetectable and a duplicate lands beside the stale original.
 *
 * This is the hottest function in the import path - two SHA-256 digests per row,
 * about 0.033 ms of CPU each measured end to end, which is why
 * `IMPORT_BATCH_LIMIT` is bounded by tool-call size rather than by CPU.
 */
export async function prepareRow(row: RosterRow): Promise<NormalizedRosterRow> {
  const { external_row_key, raw, ...content } = row;

  const normalized: NormalizedRow = {
    full_name: normalizeName(String(content.full_name ?? "")),
    organization: content.organization ? normalizeText(content.organization) : undefined,
    email: content.email ? normalizeEmail(content.email) : undefined,
    preferred_name: content.preferred_name ? normalizeText(content.preferred_name) : undefined,
    job_title: content.job_title ? normalizeText(content.job_title) : undefined,
    role: content.role ? normalizeText(content.role) : undefined,
  };

  return {
    key: await externalRowKey(normalized, external_row_key),
    content_hash: await contentHash(normalized),
    fields: row,
  };
}

export async function ensureSource(
  ctx: ToolContext,
  input: Pick<ImportRosterInput, "source_key" | "label" | "event" | "source_url">
): Promise<string> {
  const existing = await ctx.db
    .prepare("SELECT id, purged_at FROM roster_sources WHERE source_key = ?")
    .bind(input.source_key)
    .first<{ id: string; purged_at: string | null }>();

  if (existing) {
    // A PURGE IS TERMINAL. Without this check the tombstone does nothing that
    // matters, and the migration comment in 0002 asserts a protection the
    // system does not have.
    //
    // The `roster_sources` row surviving a purge stops a SECOND row being
    // created under the same key. It does not, on its own, stop the thing that
    // row exists to prevent: importing the 2027 roster under `wcus-2026` after
    // purging it. Any row whose external_row_key is a tier-2 email or a tier-3
    // name+organization digest matching a 2026 `person_sources` row then makes
    // `promoteRosterEntry` return a person from the wrong year, with
    // `linked_existing: true`, ignoring `create_new: true`, silently. That is
    // precisely the "write against the wrong person" this design names as its
    // most likely real failure.
    if (existing.purged_at !== null) {
      throw new ToolError(
        "conflict",
        `roster source ${input.source_key} was purged on ${existing.purged_at} and cannot be imported into again`,
        "call import_roster with a new source_key, for example by adding the year or the capture date"
      );
    }
    return existing.id;
  }

  const id = newId("rs");
  await ctx.db
    .prepare(
      "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(id, input.source_key, input.label, input.event ?? null, input.source_url, nowIso(ctx.clock))
    .run();
  return id;
}

export async function openOrResumeRun(
  ctx: ToolContext,
  sourceId: string,
  input: ImportRosterInput
): Promise<RunState> {
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ToolError("invalid_input", "offset must be a non-negative integer");
  }

  if (input.run_id === undefined) {
    if (offset !== 0) {
      throw new ToolError("invalid_input", "an offset without a run_id has nothing to continue");
    }
    const total = input.expected_total;
    if (!Number.isInteger(total) || (total as number) < 1) {
      throw new ToolError(
        "invalid_input",
        "expected_total is required on the first call and must be the number of rows the whole run will send"
      );
    }
    if ((total as number) < input.rows.length) {
      throw new ToolError(
        "invalid_input",
        `expected_total ${total} is smaller than this chunk of ${input.rows.length} rows`
      );
    }

    const runId = newId("ir");
    await ctx.db
      .prepare(
        `INSERT INTO import_runs
           (id, roster_source_id, format, status, expected_total, next_offset, started_at)
         VALUES (?, ?, ?, 'open', ?, 0, ?)`
      )
      .bind(runId, sourceId, input.format, total, nowIso(ctx.clock))
      .run();

    return {
      run_id: runId,
      roster_source_id: sourceId,
      expected_total: total as number,
      next_offset: 0,
    };
  }

  const runId = assertId("ir", input.run_id);
  const run = await ctx.db
    .prepare(
      `SELECT id, roster_source_id, format, status, expected_total, next_offset
       FROM import_runs WHERE id = ?`
    )
    .bind(runId)
    .first<{
      id: string;
      roster_source_id: string;
      format: string;
      status: string;
      expected_total: number;
      next_offset: number;
    }>();

  if (!run) throw new ToolError("not_found", `no import run with id ${runId}`);
  if (run.roster_source_id !== sourceId || run.format !== input.format || run.status !== "open") {
    throw new ToolError(
      "conflict",
      "import continuation does not match its open run; start a new run without a run_id"
    );
  }
  if (offset !== run.next_offset) {
    throw new ToolError(
      "conflict",
      `import run ${runId} expects offset ${run.next_offset}, not ${offset}`
    );
  }
  if (run.next_offset + input.rows.length > run.expected_total) {
    throw new ToolError(
      "conflict",
      `import run ${runId} was opened for ${run.expected_total} rows and this chunk would exceed it`
    );
  }

  return {
    run_id: run.id,
    roster_source_id: run.roster_source_id,
    expected_total: run.expected_total,
    next_offset: run.next_offset,
  };
}
