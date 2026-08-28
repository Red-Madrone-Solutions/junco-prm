import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import {
  deleteEncounter,
  listEncounters,
  logEncounter,
  updateEncounter,
} from "../src/tools/encounters";
import { createPerson, getPerson, updatePerson } from "../src/tools/people";

let now = new Date("2026-08-21T02:30:00Z"); // still the 20th in Los Angeles
const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => now,
};

beforeEach(async () => {
  now = new Date("2026-08-21T02:30:00Z");
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("logEncounter", () => {
  it("defaults occurred_on to the owner's local date, not the UTC date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, {
      person_id: person.id,
      summary: "hallway track",
    });
    expect(encounter.occurred_on).toBe("2026-08-20");
    expect(encounter.id).toMatch(/^enc_/);
    expect(encounter.record_kind).toBe("encounter");
  });

  it("returns the full person alongside the encounter", async () => {
    const person = await createPerson(ctx, { full_name: "Ada", organization: "Kinsta" });
    const out = await logEncounter(ctx, { person_id: person.id, summary: "met" });
    expect(out.person.id).toBe(person.id);
    expect(out.person.encounter_count).toBe(1);
    expect(out.person.recent_encounters).toHaveLength(1);
  });

  it("rejects a roster entry id", async () => {
    await expect(
      logEncounter(ctx, { person_id: newId("re"), summary: "met" })
    ).rejects.toThrow(ToolError);
  });

  it("requires a summary", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(logEncounter(ctx, { person_id: person.id, summary: " " })).rejects.toThrow(ToolError);
  });

  it("does not duplicate on a retried call with the same idempotency_key", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const a = await logEncounter(ctx, { person_id: person.id, summary: "met", idempotency_key: "k1" });
    const b = await logEncounter(ctx, { person_id: person.id, summary: "met", idempotency_key: "k1" });
    expect(b.encounter.id).toBe(a.encounter.id);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM encounters").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("accepts an explicit occurred_on local date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, {
      person_id: person.id,
      summary: "met",
      occurred_on: "2026-08-15",
    });
    expect(encounter.occurred_on).toBe("2026-08-15");
  });

  it("rejects an occurred_on that is an instant rather than a local date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      logEncounter(ctx, { person_id: person.id, summary: "met", occurred_on: "2026-08-15T00:00:00Z" })
    ).rejects.toThrow(ToolError);
  });

  it("accepts an explicit occurred_at ISO-8601 UTC instant", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, {
      person_id: person.id,
      summary: "met",
      occurred_at: "2026-08-15T18:30:00Z",
    });
    expect(encounter.occurred_at).toBe("2026-08-15T18:30:00Z");
  });

  it("rejects an occurred_at that is a local date rather than an instant", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      logEncounter(ctx, { person_id: person.id, summary: "met", occurred_at: "2026-08-15" })
    ).rejects.toThrow(ToolError);
  });
});

describe("updateEncounter", () => {
  it("corrects a mis-logged summary", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "wrong" });
    const fixed = await updateEncounter(ctx, { encounter_id: encounter.id, summary: "right" });
    expect(fixed.summary).toBe("right");
  });

  it("rejects an unknown encounter", async () => {
    await expect(
      updateEncounter(ctx, { encounter_id: newId("enc"), summary: "x" })
    ).rejects.toThrow(ToolError);
  });

  it("corrects occurred_at", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "met" });
    const fixed = await updateEncounter(ctx, {
      encounter_id: encounter.id,
      occurred_at: "2026-08-15T18:30:00Z",
    });
    expect(fixed.occurred_at).toBe("2026-08-15T18:30:00Z");
  });

  it("rejects an occurred_at that is a local date rather than an instant", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "met" });
    await expect(
      updateEncounter(ctx, { encounter_id: encounter.id, occurred_at: "2026-08-15" })
    ).rejects.toThrow(ToolError);
  });
});

describe("deleteEncounter", () => {
  it("removes the encounter in one call, because erasing a mistake is the point", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "oops" });
    const out = await deleteEncounter(ctx, { encounter_id: encounter.id });
    expect(out.status).toBe("deleted");
    const detail = await getPerson(ctx, { person_id: person.id });
    expect(detail.encounter_count).toBe(0);
  });
});

describe("listEncounters", () => {
  it("filters by event", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await logEncounter(ctx, { person_id: person.id, summary: "a", event: "WCUS 2026" });
    await logEncounter(ctx, { person_id: person.id, summary: "b", event: "WCEU 2026" });
    const out = await listEncounters(ctx, { event: "WCUS 2026" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.summary).toBe("a");
  });

  it("filters by date range", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await logEncounter(ctx, { person_id: person.id, summary: "old", occurred_on: "2026-01-01" });
    await logEncounter(ctx, { person_id: person.id, summary: "new", occurred_on: "2026-08-15" });
    const out = await listEncounters(ctx, { since: "2026-06-01" });
    expect(out.results.map((e) => e.summary)).toEqual(["new"]);
  });

  it("rejects a since that is not a local date", async () => {
    await expect(listEncounters(ctx, { since: "June" })).rejects.toThrow(ToolError);
  });

  it("walks every page without skipping or repeating a row", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    for (let i = 1; i <= 5; i++) {
      await logEncounter(ctx, {
        person_id: person.id,
        summary: `n${i}`,
        occurred_on: `2026-08-0${i}`,
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listEncounters(ctx, { person_id: person.id, limit: 2, cursor });
      seen.push(...page.results.map((e) => e.summary));
      cursor = page.next_cursor ?? undefined;
      pages++;
      if (pages > 10) throw new Error("pagination did not terminate");
    } while (cursor !== undefined);

    // Newest first, every row exactly once.
    expect(seen).toEqual(["n5", "n4", "n3", "n2", "n1"]);
  });

  it("orders rows sharing one date by id ascending across pages, not by insertion order", async () => {
    // Ids are random UUIDs, unrelated to insertion order, so the only way this
    // test can pass by accident is if SQLite's default scan order happens to
    // match - which is exactly what let a broken build with no `id ASC`
    // tiebreak pass a weaker version of this test that checked set membership
    // only. Sorting the actually-issued ids ourselves and comparing against
    // that order is what makes a missing tiebreak fail here: the only way the
    // walk can produce this exact sequence is if the query itself is sorting
    // by id.
    const person = await createPerson(ctx, { full_name: "Ada" });
    const logged = [];
    for (let i = 1; i <= 4; i++) {
      const { encounter } = await logEncounter(ctx, {
        person_id: person.id,
        summary: `same${i}`,
        occurred_on: "2026-08-01",
      });
      logged.push(encounter);
    }
    const expected = [...logged].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => e.summary);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      // limit: 1 forces four separate pages, so the tiebreak has to hold at
      // every cursor boundary, not just within one page's ORDER BY.
      const page = await listEncounters(ctx, { person_id: person.id, limit: 1, cursor });
      seen.push(...page.results.map((e) => e.summary));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual(expected);
  });
});

describe("subject_id", () => {
  // Every person-scoped write must record the person id as subject_id, so a
  // later delete_person can scrub the stored response. logEncounter passes
  // personId directly; updateEncounter and deleteEncounter can only learn it
  // via the subjectFromResult callback, which is unexercised without this.

  async function subjectIdFor(key: string): Promise<string | null> {
    const row = await env.DB
      .prepare("SELECT subject_id FROM idempotency_keys WHERE key = ?")
      .bind(key)
      .first<{ subject_id: string | null }>();
    return row?.subject_id ?? null;
  }

  it("logEncounter", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await logEncounter(ctx, { person_id: person.id, summary: "met", idempotency_key: "k1" });
    expect(await subjectIdFor("log_encounter:k1")).toBe(person.id);
  });

  it("updateEncounter", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "met" });
    await updateEncounter(ctx, { encounter_id: encounter.id, summary: "fixed", idempotency_key: "k1" });
    expect(await subjectIdFor("update_encounter:k1")).toBe(person.id);
  });

  it("deleteEncounter", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "met" });
    await deleteEncounter(ctx, { encounter_id: encounter.id, idempotency_key: "k1" });
    expect(await subjectIdFor("delete_encounter:k1")).toBe(person.id);
  });
});

describe("person_name", () => {
  it("an encounter carries its person's name inline", async () => {
    const person = await createPerson(ctx, { full_name: "Hedy Lamarr" });
    const logged = await logEncounter(ctx, {
      person_id: person.id,
      occurred_on: "2026-08-27",
      summary: "met at the hallway track",
    });
    expect(logged.encounter.person_name).toBe("Hedy Lamarr");

    const listed = await listEncounters(ctx, { person_id: person.id });
    expect(listed.results[0]!.person_name).toBe("Hedy Lamarr");
  });

  it("person_name follows a rename, because it is joined at read time", async () => {
    const person = await createPerson(ctx, { full_name: "Hedy Lamarr" });
    await logEncounter(ctx, { person_id: person.id, occurred_on: "2026-08-27", summary: "met" });
    await updatePerson(ctx, { person_id: person.id, full_name: "Julia G. Golomb" });
    const listed = await listEncounters(ctx, { person_id: person.id });
    expect(listed.results[0]!.person_name).toBe("Julia G. Golomb");
  });
});
