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

describe("confirmation tokens", () => {
  it("redeems a matching token exactly once", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", { full_name: "Ada" });
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", token)).resolves.toBeUndefined();
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", token)).rejects.toThrow(ToolError);
  });

  it("rejects a token minted for a different target", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    await expect(redeemConfirmation(ctx, "delete_person", "p_2", token)).rejects.toThrow(ToolError);
  });

  it("rejects a token minted for a different action", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    await expect(redeemConfirmation(ctx, "purge_roster_source", "p_1", token)).rejects.toThrow(ToolError);
  });

  it("rejects an expired token", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    now = new Date("2026-08-20T12:31:00Z");
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", token)).rejects.toThrow(ToolError);
  });

  it("rejects a missing or malformed token", async () => {
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", undefined)).rejects.toThrow(ToolError);
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", "nonsense")).rejects.toThrow(ToolError);
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
