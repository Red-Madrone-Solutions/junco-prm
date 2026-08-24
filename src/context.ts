import { localDate } from "./time";

export interface ToolContext {
  db: D1Database;
  /** The owner's IANA zone, from the OWNER_TIMEZONE deploy variable. */
  timezone: string;
  clock: () => Date;
}

/** The current date in the owner's zone, as YYYY-MM-DD. */
export function today(ctx: ToolContext): string {
  return localDate(ctx.timezone, ctx.clock());
}

/**
 * Every tool result passes through this, read and write alike.
 *
 * The agent does not otherwise know what day it is. "Follow up tomorrow,"
 * dictated at 11pm Pacific, is wrong for roughly a third of every day if the
 * model assumes UTC or guesses. One field on every response removes that whole
 * class of off-by-one error from the highest-frequency writes.
 *
 * APPLIED AT THE REGISTRY SEAM, NOT INSIDE EACH TOOL. Task 16 wraps every
 * `run()` in the registry with this, so the tool functions return bare bodies
 * and no tool can ship a result without the date. A per-tool call is a per-tool
 * decision, and a per-tool decision is one a tool can forget: the previous draft
 * made it 26 times and got it right once, in `listDue`. Task 16's contract tests
 * assert that every tool in the registry returns a result carrying `today`.
 */
export function envelope<T extends object>(ctx: ToolContext, body: T): T & { today: string } {
  return { ...body, today: today(ctx) };
}
