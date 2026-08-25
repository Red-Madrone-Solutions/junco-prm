import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { mintConfirmation, redeemConfirmation } from "../src/confirm";

let now = new Date("2026-08-20T12:00:00Z");
const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => now,
};

beforeEach(async () => {
  now = new Date("2026-08-20T12:00:00Z");
  await env.DB.prepare("DELETE FROM confirmations").run();
});

/** Runs the call, expects a ToolError, and hands it back for inspection. */
async function expectToolError(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return e as ToolError;
  }
  throw new Error("expected a ToolError, got a result");
}

describe("confirmation tokens", () => {
  it("redeems a matching token exactly once", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", { full_name: "Ada" });
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", token)).resolves.toBeUndefined();
    const error = await expectToolError(redeemConfirmation(ctx, "delete_person", "p_1", token));
    expect(error.code).toBe("confirmation_invalid");
  });

  it("rejects a token minted for a different target", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    const error = await expectToolError(redeemConfirmation(ctx, "delete_person", "p_2", token));
    expect(error.code).toBe("confirmation_invalid");
  });

  it("rejects a token minted for a different action", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    const error = await expectToolError(
      redeemConfirmation(ctx, "purge_roster_source", "p_1", token)
    );
    expect(error.code).toBe("confirmation_invalid");
  });

  it("rejects an expired token", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    now = new Date("2026-08-20T12:31:00Z");
    const error = await expectToolError(redeemConfirmation(ctx, "delete_person", "p_1", token));
    // Not `conflict`, not `invalid_input`: a client distinguishes "take a fresh
    // preview" from "your arguments were wrong" by this code alone.
    expect(error.code).toBe("confirmation_invalid");
    expect(error.message).toContain("expired");
  });

  it("rejects a missing or malformed token", async () => {
    // Anything that is not shaped like a token at all reads as "you have not
    // previewed yet", so the corrective call is the preview. A well-formed
    // token this server never issued is a different answer - the caller DID
    // preview something, just not this - and carries confirmation_invalid.
    expect((await expectToolError(redeemConfirmation(ctx, "delete_person", "p_1", undefined))).code)
      .toBe("confirmation_required");
    expect((await expectToolError(redeemConfirmation(ctx, "delete_person", "p_1", "nonsense"))).code)
      .toBe("confirmation_required");
    expect(
      (await expectToolError(redeemConfirmation(ctx, "delete_person", "p_1", "cnf_not-a-real-token")))
        .code
    ).toBe("confirmation_invalid");
  });

  it("rejects a null token at the database layer", async () => {
    // THIS IS WHY `token` CARRIES AN EXPLICIT NOT NULL.
    //
    // SQLite permits NULL in a PRIMARY KEY column unless it is INTEGER PRIMARY
    // KEY or the table is WITHOUT ROWID. Without NOT NULL, this insert would
    // succeed and leave an unredeemable, invisible confirmation row.
    await expect(
      env.DB.prepare(
        "INSERT INTO confirmations (token, action, target_id, preview, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(null, "delete_person", "p_1", "{}", "2026-08-20T12:00:00Z", "2026-08-20T12:30:00Z")
        .run()
    ).rejects.toThrow();
  });
});
