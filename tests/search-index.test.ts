import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T = "2026-08-20T00:00:00Z";

async function insertPerson(id: string, name: string, org: string | null, notes: string | null) {
  await env.DB.prepare(
    "INSERT INTO people (id, full_name, organization, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, name, org, notes, T, T)
    .run();
}

async function search(query: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id AS id
     FROM people_fts f
     JOIN people p ON p.id = f.id
     WHERE people_fts MATCH ?
     ORDER BY bm25(people_fts)`
  )
    .bind(query)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

describe("people_fts", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM people").run();
  });

  it("indexes a person on insert", async () => {
    await insertPerson("p_1", "Ada Lovelace", "Analytical Engines", null);
    expect(await search("Lovelace")).toEqual(["p_1"]);
    expect(await search("Analytical")).toEqual(["p_1"]);
  });

  it("reindexes on update", async () => {
    await insertPerson("p_1", "Ada Lovelace", "Analytical Engines", null);
    await env.DB.prepare("UPDATE people SET organization = ? WHERE id = ?")
      .bind("Difference Engines", "p_1")
      .run();
    expect(await search("Analytical")).toEqual([]);
    expect(await search("Difference")).toEqual(["p_1"]);
  });

  it("removes from the index on delete", async () => {
    await insertPerson("p_1", "Ada Lovelace", null, null);
    await env.DB.prepare("DELETE FROM people WHERE id = ?").bind("p_1").run();
    expect(await search("Lovelace")).toEqual([]);
  });

  it("searches note text", async () => {
    await insertPerson("p_1", "Grace Hopper", null, "met at the hallway track, owes me a compiler");
    expect(await search("compiler")).toEqual(["p_1"]);
  });

  it("ranks by bm25 with the better match first", async () => {
    await insertPerson("p_1", "Ada Lovelace", "Kinsta", null);
    await insertPerson("p_2", "Someone Else", "Kinsta Kinsta Kinsta", null);
    const ranked = await search("Kinsta");
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toBe("p_2");
  });

  it("treats imported text as data, not as syntax", async () => {
    // A roster row whose job title contains FTS operators must not break the query.
    await insertPerson("p_1", "Odd Row", "NOT AND OR *", null);
    await insertPerson("p_2", "Ordinary Row", "Kinsta", null);
    // Quoted, those words are a phrase to match, not operators to evaluate.
    expect(await search(`"NOT AND OR"`)).toEqual(["p_1"]);
  });
});
