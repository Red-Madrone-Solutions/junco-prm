import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("durable core schema", () => {
  it("creates the durable tables", async () => {
    const names = await tableNames();
    expect(names).toEqual(
      expect.arrayContaining(["people", "person_contacts", "person_links", "tags", "person_tags"])
    );
  });

  it("rejects a person row with no id", async () => {
    // THIS IS WHY EVERY `id` COLUMN CARRIES AN EXPLICIT NOT NULL.
    //
    // SQLite permits NULL in a PRIMARY KEY column unless it is INTEGER PRIMARY
    // KEY or the table is WITHOUT ROWID. That is documented bug-compatibility
    // with very old versions, not an edge case, and `id TEXT PRIMARY KEY`
    // alone would accept this insert - after which `people_fts_ai` would
    // cheerfully index a row whose id is null, and every read keyed on that id
    // would miss it.
    await expect(
      env.DB.prepare("INSERT INTO people (full_name, created_at, updated_at) VALUES (?, ?, ?)")
        .bind("No Id", "2026-08-20T00:00:00Z", "2026-08-20T00:00:00Z")
        .run()
    ).rejects.toThrow();
  });

  it("rejects an explicitly null id too", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
        .bind(null, "Null Id", "2026-08-20T00:00:00Z", "2026-08-20T00:00:00Z")
        .run()
    ).rejects.toThrow();
  });

  it("enforces the person foreign key on contacts", async () => {
    // EVERY NOT NULL COLUMN IS SUPPLIED, deliberately.
    //
    // An earlier version of this test omitted `normalized_value`, which is
    // NOT NULL with no default. The insert threw on that constraint before the
    // foreign key was ever consulted, so the test passed identically with
    // foreign keys OFF - while claiming to be the thing every later cascade
    // rests on. A test that throws for the wrong reason is worse than no test,
    // because it stops anyone looking.
    await expect(
      env.DB.prepare(
        `INSERT INTO person_contacts
           (id, person_id, contact_type, value, normalized_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          "pc_1",
          "p_missing",
          "email",
          "nobody@example.com",
          "nobody@example.com",
          "2026-08-20T00:00:00Z"
        )
        .run()
    ).rejects.toThrow();
  });

  it("accepts the same row once the person exists, proving the FK was the cause", async () => {
    // The other half of the pair. Without it, the test above still passes when
    // the insert fails for some reason nobody has noticed.
    await env.DB.prepare(
      "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("p_real", "Ada Lovelace", "2026-08-20T00:00:00Z", "2026-08-20T00:00:00Z")
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO person_contacts
           (id, person_id, contact_type, value, normalized_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          "pc_2",
          "p_real",
          "email",
          "ada@example.test",
          "ada@example.test",
          "2026-08-20T00:00:00Z"
        )
        .run()
    ).resolves.toBeTruthy();
  });
});
