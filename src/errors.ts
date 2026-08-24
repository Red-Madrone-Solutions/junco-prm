/**
 * A closed set. The spec fixes these seven because clients and tests both bind
 * to them, so adding an eighth is a spec change rather than an implementation
 * detail. `limit_exceeded` covers a page size over the maximum, a chunk over
 * `IMPORT_BATCH_LIMIT`, and any other refusal whose fix is "ask for less."
 */
export type ToolErrorCode =
  | "invalid_input"
  | "invalid_id"
  | "not_found"
  | "conflict"
  | "confirmation_required"
  | "confirmation_invalid"
  | "limit_exceeded";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    /**
     * The corrective next call, where one exists. The caller is a model that
     * will otherwise guess, so an `re_` id passed to `logEncounter` says
     * "promote this roster entry first with promote_roster_entry" rather than
     * only "invalid id." Omitted when there is no single obvious next call.
     */
    public readonly next?: string,
    /**
     * Structured payload a caller can act on. `createPerson` puts duplicate
     * candidates here when it refuses, and `importRoster` puts the run's true
     * `next_offset` and `remaining` here when an offset is wrong, so the agent's
     * next call is obviously correct rather than a guess. Never contains
     * `raw_record` or any other untrusted roster text.
     */
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ToolError";
  }

  /** The shape plan 2's transport serializes. Kept here so it cannot drift. */
  toResult(): {
    error: { code: ToolErrorCode; reason: string; next?: string; details?: unknown };
  } {
    return {
      error: {
        code: this.code,
        reason: this.message,
        ...(this.next ? { next: this.next } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}
