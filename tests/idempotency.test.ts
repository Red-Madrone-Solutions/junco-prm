import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { hashJson, withIdempotency } from "../src/idempotency";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("hashJson", () => {
  it("is stable across key order", async () => {
    expect(await hashJson({ a: 1, b: 2 })).toBe(await hashJson({ b: 2, a: 1 }));
  });

  it("differs on different values", async () => {
    expect(await hashJson({ a: 1 })).not.toBe(await hashJson({ a: 2 }));
  });
});

describe("withIdempotency", () => {
  it("runs the operation when no key is given", async () => {
    const run = vi.fn().mockResolvedValue({ ok: 1 });
    const first = await withIdempotency(ctx, "log_encounter", undefined, { x: 1 }, run);
    const second = await withIdempotency(ctx, "log_encounter", undefined, { x: 1 }, run);
    expect(first).toEqual({ ok: 1 });
    expect(second).toEqual({ ok: 1 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("replays the stored result instead of running twice", async () => {
    const run = vi.fn().mockResolvedValue({ id: "enc_1" });
    const first = await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    const second = await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects the same key with a different input", async () => {
    const run = vi.fn().mockResolvedValue({ id: "enc_1" });
    await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    await expect(
      withIdempotency(ctx, "log_encounter", "k1", { x: 2 }, run)
    ).rejects.toThrow(ToolError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("scopes keys by tool", async () => {
    const run = vi.fn().mockResolvedValue({ id: "a" });
    await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    await withIdempotency(ctx, "create_followup", "k1", { x: 1 }, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not store a result when the operation throws", async () => {
    const run = vi.fn().mockRejectedValue(new ToolError("not_found", "nope"));
    await expect(withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run)).rejects.toThrow();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("refuses a second call while the first holding that key is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn().mockImplementation(async () => {
      await gate;
      return { id: "enc_1" };
    });

    const first = withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    await expect(
      withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run)
    ).rejects.toThrow(ToolError);

    release();
    await expect(first).resolves.toEqual({ id: "enc_1" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
