import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import {
  cancelFollowup,
  completeFollowup,
  listDue,
  createFollowup,
} from "../src/tools/followups";
import { createPerson, getPerson } from "../src/tools/people";

let now = new Date("2026-08-21T02:30:00Z"); // the 20th in Los Angeles, the 21st in UTC
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

describe("createFollowup", () => {
  it("stores a local due date and returns the person", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const out = await createFollowup(ctx, {
      person_id: person.id,
      due_on: "2026-08-25",
      note: "send the deck",
    });
    expect(out.followup.id).toMatch(/^fu_/);
    expect(out.followup.due_on).toBe("2026-08-25");
    expect(out.person.open_followups).toHaveLength(1);
  });

  it("rejects an instant where a local date belongs", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      createFollowup(ctx, { person_id: person.id, due_on: "2026-08-25T00:00:00Z" })
    ).rejects.toThrow(ToolError);
  });

  it("rejects vague text rather than guessing", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(createFollowup(ctx, { person_id: person.id, due_on: "tomorrow" })).rejects.toThrow(
      ToolError
    );
  });

  it("rejects a roster entry id", async () => {
    await expect(
      createFollowup(ctx, { person_id: newId("re"), due_on: "2026-08-25" })
    ).rejects.toThrow(ToolError);
  });
});

describe("completeFollowup and cancelFollowup", () => {
  it("completing closes it out and removes it from the person's open list", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    const done = await completeFollowup(ctx, { followup_id: followup.id });
    expect(done.completed_at).not.toBeNull();
    const detail = await getPerson(ctx, { person_id: person.id });
    expect(detail.open_followups).toEqual([]);
  });

  it("cancelling is distinct from completing", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    const cancelled = await cancelFollowup(ctx, { followup_id: followup.id });
    expect(cancelled.cancelled_at).not.toBeNull();
    expect(cancelled.completed_at).toBeNull();
  });

  it("refuses to complete an already-completed follow-up", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    await completeFollowup(ctx, { followup_id: followup.id });
    await expect(completeFollowup(ctx, { followup_id: followup.id })).rejects.toThrow(ToolError);
  });
});

describe("listDue", () => {
  it("computes today in the owner's zone, not in UTC", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    // Due on the 20th. In Los Angeles it is the 20th, so this is due today, not overdue.
    await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-20" });
    const out = await listDue(ctx, {});
    expect(out.as_of).toBe("2026-08-20");
    expect(out.timezone).toBe("America/Los_Angeles");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.days_overdue).toBe(0);
  });

  it("puts the most overdue first and names the person inline", async () => {
    const a = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const b = await createPerson(ctx, { full_name: "Grace Hopper" });
    await createFollowup(ctx, { person_id: a.id, due_on: "2026-08-18" });
    await createFollowup(ctx, { person_id: b.id, due_on: "2026-08-10" });

    const out = await listDue(ctx, {});
    expect(out.results.map((r) => r.person_name)).toEqual(["Grace Hopper", "Ada Lovelace"]);
    expect(out.results[0]?.days_overdue).toBe(10);
    expect(out.results[1]?.days_overdue).toBe(2);
  });

  it("excludes future follow-ups unless a horizon is given", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await createFollowup(ctx, { person_id: person.id, due_on: "2026-09-30" });
    expect((await listDue(ctx, {})).results).toEqual([]);
    expect((await listDue(ctx, { through: "2026-10-01" })).results).toHaveLength(1);
  });

  it("excludes completed and cancelled follow-ups", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const one = await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-01" });
    const two = await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-02" });
    await completeFollowup(ctx, { followup_id: one.followup.id });
    await cancelFollowup(ctx, { followup_id: two.followup.id });
    expect((await listDue(ctx, {})).results).toEqual([]);
  });

  it("rejects a cursor this server did not issue", async () => {
    await expect(listDue(ctx, { cursor: "not-a-real-cursor" })).rejects.toThrow(ToolError);
  });

  it("paginates in exact due_on/id order across pages, including ties", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    // All four share one due date, so only the id tiebreak keeps the order
    // stable across cursor boundaries. Captured as they're created so the
    // expected order is computed independently of insertion or scan order.
    const created = [];
    for (let i = 0; i < 4; i++) {
      const { followup } = await createFollowup(ctx, {
        person_id: person.id,
        due_on: "2026-08-01",
      });
      created.push(followup);
    }
    const expected = [...created].sort((a, b) => (a.id < b.id ? -1 : 1)).map((f) => f.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listDue(ctx, { limit: 1, cursor });
      seen.push(...page.results.map((r) => r.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual(expected);
  });
});

describe("subject_id", () => {
  // Every person-scoped write must record the person id as subject_id, so a
  // later delete_person can scrub the stored response. createFollowup passes
  // personId directly; completeFollowup and cancelFollowup can only learn it
  // via the subjectFromResult callback, which is unexercised without this.

  async function subjectIdFor(key: string): Promise<string | null> {
    const row = await env.DB
      .prepare("SELECT subject_id FROM idempotency_keys WHERE key = ?")
      .bind(key)
      .first<{ subject_id: string | null }>();
    return row?.subject_id ?? null;
  }

  it("createFollowup", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-25", idempotency_key: "k1" });
    expect(await subjectIdFor("create_followup:k1")).toBe(person.id);
  });

  it("completeFollowup", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    await completeFollowup(ctx, { followup_id: followup.id, idempotency_key: "k1" });
    expect(await subjectIdFor("complete_followup:k1")).toBe(person.id);
  });

  it("cancelFollowup", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await createFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    await cancelFollowup(ctx, { followup_id: followup.id, idempotency_key: "k1" });
    expect(await subjectIdFor("cancel_followup:k1")).toBe(person.id);
  });
});
