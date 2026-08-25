import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { ensureSource, openOrResumeRun, parseCsv, prepareRow } from "../src/tools/import_state";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

const SOURCE = {
  source_key: "wcus-2026",
  label: "WordCamp US 2026",
  event: "WCUS 2026",
  source_url: "https://example.test/attendees",
  format: "json" as const,
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
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

describe("parseCsv", () => {
  it("parses a header row and quoted fields containing commas", () => {
    const rows = parseCsv('full_name,organization\n"Lovelace, Ada",Kinsta\n');
    expect(rows).toEqual([{ full_name: "Lovelace, Ada", organization: "Kinsta" }]);
  });

  it("handles escaped quotes", () => {
    const rows = parseCsv('full_name\n"Ada ""The Countess"" Lovelace"\n');
    expect(rows[0]?.full_name).toBe('Ada "The Countess" Lovelace');
  });

  it("ignores a trailing blank line", () => {
    expect(parseCsv("full_name\nAda\n\n")).toHaveLength(1);
  });
});

describe("prepareRow", () => {
  it("uses the source's key when it has one", async () => {
    const out = await prepareRow({ external_row_key: "row-7", full_name: "Ada" });
    expect(out.key).toBe("k:row-7");
  });

  it("falls back to the normalized email when the source has no key", async () => {
    const out = await prepareRow({ full_name: "Ada Lovelace", email: "Ada@Example.TEST" });
    expect(out.key).toBe("e:ada@example.test");
  });

  it("falls back to a name-plus-organization digest when there is no email either", async () => {
    const a = await prepareRow({ full_name: "Ada Lovelace", organization: "Kinsta" });
    const b = await prepareRow({ organization: "Kinsta", full_name: "Ada Lovelace" });
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^h:[0-9a-f]{64}$/); // tier prefix plus hex SHA-256
  });

  it("gives two same-named people at different organizations different keys", async () => {
    const a = await prepareRow({ full_name: "Chris Smith", organization: "A" });
    const b = await prepareRow({ full_name: "Chris Smith", organization: "B" });
    expect(a.key).not.toBe(b.key);
  });

  it("KEEPS THE KEY and MOVES THE HASH when a field outside the identity subset changes", async () => {
    // This is the case the previous single-value design broke, and it is
    // invisible to any test that imports a roster only once. A corrected job
    // title must produce an UPDATE to one row, not a second row beside a stale
    // original with the person's provenance pointing at the wrong one.
    const before = await prepareRow({
      full_name: "Ada Lovelace",
      organization: "Kinsta",
      job_title: "Programmer",
    });
    const after = await prepareRow({
      full_name: "Ada Lovelace",
      organization: "Kinsta",
      job_title: "Senior Programmer",
    });

    expect(after.key).toBe(before.key);
    expect(after.content_hash).not.toBe(before.content_hash);
  });

  it("keeps the key stable when the source supplies one, whatever else changes", async () => {
    const before = await prepareRow({ external_row_key: "row-7", full_name: "Ada Lovelace" });
    const after = await prepareRow({ external_row_key: "row-7", full_name: "Ada Byron" });
    expect(after.key).toBe(before.key);
    expect(after.content_hash).not.toBe(before.content_hash);
  });

  it("does not strip plus-addressing when an email becomes the key", async () => {
    const a = await prepareRow({ full_name: "Ada", email: "ada+wcus@example.test" });
    const b = await prepareRow({ full_name: "Ada", email: "ada@example.test" });
    // Possibly a different person's mailbox alias. Merging two people costs
    // more than carrying two rows.
    expect(a.key).not.toBe(b.key);
  });

  it("ignores `raw` when computing either value", async () => {
    // `raw` is the untouched source record, stored for provenance. Including it
    // would make every key and hash depend on formatting noise from the source.
    const a = await prepareRow({ full_name: "Ada", raw: { page: 1 } });
    const b = await prepareRow({ full_name: "Ada", raw: { page: 2 } });
    expect(a.key).toBe(b.key);
    expect(a.content_hash).toBe(b.content_hash);
  });
});

describe("ensureSource", () => {
  it("creates once and returns the same id afterwards", async () => {
    const first = await ensureSource(ctx, SOURCE);
    const second = await ensureSource(ctx, SOURCE);
    expect(first).toMatch(/^rs_/);
    expect(second).toBe(first);
  });
});

describe("openOrResumeRun", () => {
  const rows = [{ external_row_key: "1", full_name: "Ada" }];

  it("opens a run on a first call that declares its total", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const run = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 3 });
    expect(run.run_id).toMatch(/^ir_/);
    expect(run.expected_total).toBe(3);
    expect(run.next_offset).toBe(0);
  });

  it("refuses a first call that declares no total", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    await expect(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows })
    ).rejects.toThrow(ToolError);
  });

  it("refuses a declared total smaller than the first chunk", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    await expect(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 0 })
    ).rejects.toThrow(ToolError);
  });

  it("refuses a first call that starts partway through", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    await expect(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 9, offset: 5 })
    ).rejects.toThrow(ToolError);
  });

  it("resumes a run at the offset it expects", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 2 });
    await env.DB.prepare("UPDATE import_runs SET next_offset = 1 WHERE id = ?")
      .bind(opened.run_id)
      .run();

    const resumed = await openOrResumeRun(ctx, sourceId, {
      ...SOURCE,
      rows,
      run_id: opened.run_id,
      offset: 1,
    });
    expect(resumed.run_id).toBe(opened.run_id);
    expect(resumed.next_offset).toBe(1);
    expect(resumed.expected_total).toBe(2);
  });

  it("refuses a continuation whose offset skips rows, with the true offset in details", async () => {
    // The spec: "A mismatch is a recoverable error: the response carries the
    // run's true next_offset and remaining, so the agent's next call is
    // obviously correct rather than a guess." It used to be in the prose only.
    const sourceId = await ensureSource(ctx, SOURCE);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 9 });
    const error = await expectToolError(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, run_id: opened.run_id, offset: 1 })
    );
    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({ run_id: opened.run_id, next_offset: 0, remaining: 9 });
    expect(error.next).toContain("offset 0");
  });

  it("refuses a continuation whose offset replays committed rows", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 9 });
    await env.DB.prepare("UPDATE import_runs SET next_offset = 4 WHERE id = ?")
      .bind(opened.run_id)
      .run();
    const error = await expectToolError(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, run_id: opened.run_id, offset: 0 })
    );
    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({ run_id: opened.run_id, next_offset: 4, remaining: 5 });
  });

  it("refuses a continuation that would exceed the declared total, with remaining in details", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 1 });
    await env.DB.prepare("UPDATE import_runs SET next_offset = 1 WHERE id = ?")
      .bind(opened.run_id)
      .run();
    const error = await expectToolError(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, run_id: opened.run_id, offset: 1 })
    );
    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({ run_id: opened.run_id, next_offset: 1, remaining: 0 });
    expect(error.next).toContain("at most 0");
  });

  it("refuses a continuation whose format changed", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 2 });
    await env.DB.prepare("UPDATE import_runs SET next_offset = 1 WHERE id = ?")
      .bind(opened.run_id)
      .run();
    await expect(
      openOrResumeRun(ctx, sourceId, {
        ...SOURCE,
        format: "text",
        rows,
        run_id: opened.run_id,
        offset: 1,
      })
    ).rejects.toThrow(ToolError);

    const error = await expectToolError(
      openOrResumeRun(ctx, sourceId, {
        ...SOURCE,
        format: "text",
        rows,
        run_id: opened.run_id,
        offset: 1,
      })
    );
    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({ run_id: opened.run_id, next_offset: 1, remaining: 1 });
  });

  it("refuses a run belonging to another source", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, expected_total: 2 });

    const otherId = await ensureSource(ctx, { ...SOURCE, source_key: "wceu-2026" });
    await expect(
      openOrResumeRun(ctx, otherId, { ...SOURCE, rows, run_id: opened.run_id, offset: 0 })
    ).rejects.toThrow(ToolError);
  });

  it("rejects a run id of the wrong kind", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    await expect(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, run_id: "rs_nope", offset: 0 })
    ).rejects.toThrow(ToolError);
  });
});
