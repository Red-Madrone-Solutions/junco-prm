import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { findChunkReceipt, recordChunkReceipt } from "../src/idempotency";
import { hashJson } from "../src/idempotency";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

const T = "2026-08-20T00:00:00Z";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM import_chunk_receipts").run();
  await env.DB.prepare("DELETE FROM import_runs").run();
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare(
    "INSERT INTO roster_sources (id, source_key, label, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind("rs_a", "wcus-2026", "WordCamp US 2026", T)
    .run();
  await env.DB.prepare(
    "INSERT INTO import_runs (id, roster_source_id, format, status, expected_total, next_offset, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind("ir_a", "rs_a", "csv", "open", 300, 150, T)
    .run();
});

describe("chunk receipts", () => {
  it("replays a retried chunk carrying the same rows", async () => {
    const hash = await hashJson([{ external_row_key: "1" }]);
    const result = { imported: 1, updated: 0, skipped: 0, next_offset: 1, remaining: 299 };
    await recordChunkReceipt(ctx, "ir_a", 0, 1, hash, result);

    expect(await findChunkReceipt(ctx, "ir_a", 0, hash)).toEqual(result);
  });

  it("returns null for an offset that has no receipt", async () => {
    const hash = await hashJson([{ external_row_key: "1" }]);
    expect(await findChunkReceipt(ctx, "ir_a", 7, hash)).toBeNull();
  });

  it("refuses a DIFFERENT chunk presenting an already-consumed offset", async () => {
    // A retry replays. A different payload at the same offset is a caller bug
    // and must not silently overwrite committed ground.
    const original = await hashJson([{ external_row_key: "1" }]);
    await recordChunkReceipt(ctx, "ir_a", 0, 1, original, { imported: 1 });

    const different = await hashJson([{ external_row_key: "99" }]);
    await expect(findChunkReceipt(ctx, "ir_a", 0, different)).rejects.toThrow();
  });

  it("scopes receipts to their run", async () => {
    await env.DB.prepare(
      "INSERT INTO import_runs (id, roster_source_id, format, status, expected_total, next_offset, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("ir_b", "rs_a", "csv", "open", 10, 0, T)
      .run();
    const hash = await hashJson([{ external_row_key: "1" }]);
    await recordChunkReceipt(ctx, "ir_a", 0, 1, hash, { imported: 1 });

    expect(await findChunkReceipt(ctx, "ir_b", 0, hash)).toBeNull();
  });
});
