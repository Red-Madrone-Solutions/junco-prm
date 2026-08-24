import type { ToolContext } from "./context";
import { ToolError } from "./errors";
import { nowIso } from "./time";

const TTL_MS = 30 * 60 * 1000;

export async function mintConfirmation(
  ctx: ToolContext,
  action: string,
  targetId: string,
  preview: unknown
): Promise<string> {
  const token = `cnf_${crypto.randomUUID()}`;
  const issued = ctx.clock();
  await ctx.db
    .prepare(
      "INSERT INTO confirmations (token, action, target_id, preview, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(
      token,
      action,
      targetId,
      JSON.stringify(preview),
      issued.toISOString(),
      new Date(issued.getTime() + TTL_MS).toISOString()
    )
    .run();
  return token;
}

export async function redeemConfirmation(
  ctx: ToolContext,
  action: string,
  targetId: string,
  token: unknown,
  /**
   * The preview as it looks NOW, re-read by the caller immediately before
   * redeeming. Compared against what the token was minted from.
   *
   * The two-call protocol exists so a human can read what is about to be
   * destroyed. A token that authorizes something different from what was shown
   * defeats the entire mechanism: a `purge_roster_source` preview reporting 0
   * entries can otherwise authorize deleting 100 rows imported between the two
   * calls, and the human approved a preview that said nothing would be lost.
   *
   * Optional only so the signature can be adopted task by task. Every caller
   * passes it.
   */
  currentPreview?: unknown
): Promise<void> {
  if (typeof token !== "string" || !token.startsWith("cnf_")) {
    throw new ToolError(
      "confirmation_required",
      `${action} needs a confirmation_token from a preview call`
    );
  }

  const at = nowIso(ctx.clock);

  // One conditional UPDATE performs every check. Reading the row first and updating
  // second lets two calls both pass the read and both redeem the same token.
  const redeemed = await ctx.db
    .prepare(
      `UPDATE confirmations
          SET redeemed_at = ?
        WHERE token = ?
          AND action = ?
          AND target_id = ?
          AND redeemed_at IS NULL
          AND expires_at > ?`
    )
    .bind(at, token, action, targetId, at)
    .run();

  if (redeemed.meta.changes === 1) {
    if (currentPreview === undefined) return;

    // The token is spent by now, deliberately. If the state moved, this call
    // fails AND the stale token is dead, so the caller has to take a fresh
    // preview rather than retrying against the same one.
    const minted = await ctx.db
      .prepare("SELECT preview FROM confirmations WHERE token = ?")
      .bind(token)
      .first<{ preview: string }>();

    if (minted && minted.preview !== JSON.stringify(currentPreview)) {
      throw new ToolError(
        "conflict",
        `the data changed since that preview was taken, so ${action} was not performed`,
        `call ${action} again with only the target id to see a current preview`
      );
    }
    return;
  }

  // The update matched nothing. Read the row only to say why, never to decide.
  const row = await ctx.db
    .prepare("SELECT action, target_id, expires_at, redeemed_at FROM confirmations WHERE token = ?")
    .bind(token)
    .first<{ action: string; target_id: string; expires_at: string; redeemed_at: string | null }>();

  if (!row) throw new ToolError("confirmation_invalid", "unknown confirmation_token");
  if (row.redeemed_at) throw new ToolError("confirmation_invalid", "confirmation_token already used");
  if (row.action !== action || row.target_id !== targetId) {
    throw new ToolError("confirmation_invalid", "confirmation_token does not match this operation");
  }
  throw new ToolError("confirmation_invalid", "confirmation_token expired");
}
