import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import {
  IDEMPOTENCY_RETENTION_MS,
  IN_FLIGHT_RECLAIM_MS,
  withIdempotency,
} from "../src/idempotency";

// A MUTABLE clock, unlike every other test file in this suite. See the note
// above: a frozen instant cannot test a feature about elapsed time, and three
// defects in plan 1 hid behind exactly that.
let now = new Date("2026-08-20T12:00:00Z");
const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => now,
};

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

beforeEach(async () => {
  now = new Date("2026-08-20T12:00:00Z");
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

/** Wedge a key the way an evicted isolate does: claim it, never complete it. */
async function wedge(key: string, tool = "log_encounter") {
  await expect(
    withIdempotency(ctx, tool, key, { a: 1 }, async () => {
      throw new Error("isolate evicted");
    })
  ).rejects.toThrow("isolate evicted");
  // withIdempotency's catch releases the claim, so put it back by hand - the
  // crash this task is about happens AFTER run() returns, where no catch runs.
  await env.DB.prepare(
    `INSERT INTO idempotency_keys (key, tool, subject_id, request_hash, response_json, created_at)
     VALUES (?, ?, NULL, ?, NULL, ?)`
  )
    .bind(`${tool}:${key}`, tool, await hashOf({ a: 1 }), now.toISOString())
    .run();
}

async function hashOf(input: unknown) {
  const { hashJson } = await import("../src/idempotency");
  return hashJson(input);
}

describe("a wedged claim", () => {
  it("still refuses a retry while the original call could plausibly be running", async () => {
    await wedge("k1");
    advance(IN_FLIGHT_RECLAIM_MS - 1000);

    await expect(
      withIdempotency(ctx, "log_encounter", "k1", { a: 1 }, async () => "second run")
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("is RECLAIMED once no isolate could still be holding it", async () => {
    await wedge("k2");
    advance(IN_FLIGHT_RECLAIM_MS + 1000);

    const result = await withIdempotency(
      ctx,
      "log_encounter",
      "k2",
      { a: 1 },
      async () => "second run"
    );
    expect(result).toBe("second run");

    // And the reclaimed key now behaves like any completed key.
    const replay = await withIdempotency(
      ctx,
      "log_encounter",
      "k2",
      { a: 1 },
      async () => "third run"
    );
    expect(replay).toBe("second run");
  });

  it("is reclaimed only for the SAME arguments", async () => {
    await wedge("k3");
    advance(IN_FLIGHT_RECLAIM_MS + 1000);

    await expect(
      withIdempotency(ctx, "log_encounter", "k3", { a: 2 }, async () => "different input")
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("is reclaimed by exactly one of two concurrent retries", async () => {
    await wedge("k4");
    advance(IN_FLIGHT_RECLAIM_MS + 1000);

    const runs: string[] = [];
    const both = await Promise.allSettled([
      withIdempotency(ctx, "log_encounter", "k4", { a: 1 }, async () => {
        runs.push("A");
        return "A";
      }),
      withIdempotency(ctx, "log_encounter", "k4", { a: 1 }, async () => {
        runs.push("B");
        return "B";
      }),
    ]);

    // One reclaims and runs. The other either replays its result or is refused
    // as in flight, but it must NOT run the operation a second time.
    expect(runs).toHaveLength(1);
    expect(both.some((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("the prune", () => {
  it("removes a COMPLETED row past the retention window", async () => {
    await withIdempotency(ctx, "log_encounter", "old", { a: 1 }, async () => "done");
    advance(IDEMPOTENCY_RETENTION_MS + 1000);

    // Any later claim triggers the opportunistic sweep.
    await withIdempotency(ctx, "log_encounter", "new", { a: 1 }, async () => "done");

    const row = await env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = ?")
      .bind("log_encounter:old")
      .first();
    expect(row).toBeNull();
  });

  it("removes a WEDGED claim nobody ever retried", async () => {
    await wedge("abandoned");
    advance(IDEMPOTENCY_RETENTION_MS + 1000);

    await withIdempotency(ctx, "log_encounter", "unrelated", { a: 1 }, async () => "done");

    const row = await env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = ?")
      .bind("log_encounter:abandoned")
      .first();
    expect(row).toBeNull();
  });

  it("leaves a row that is inside the window", async () => {
    await withIdempotency(ctx, "log_encounter", "recent", { a: 1 }, async () => "done");
    advance(IDEMPOTENCY_RETENTION_MS - 1000);

    await withIdempotency(ctx, "log_encounter", "other", { a: 1 }, async () => "done");

    const row = await env.DB.prepare("SELECT key FROM idempotency_keys WHERE key = ?")
      .bind("log_encounter:recent")
      .first();
    expect(row).not.toBeNull();
  });

  it("deletes at most PRUNE_BATCH rows in one call", async () => {
    for (let i = 0; i < 150; i++) {
      await withIdempotency(ctx, "log_encounter", `bulk-${i}`, { a: 1 }, async () => "done");
    }
    advance(IDEMPOTENCY_RETENTION_MS + 1000);

    await withIdempotency(ctx, "log_encounter", "trigger", { a: 1 }, async () => "done");

    const { n } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM idempotency_keys"
    ).first<{ n: number }>())!;
    // 150 old rows minus one bounded sweep of 100, plus the trigger row itself.
    expect(n).toBe(51);
  });
});
