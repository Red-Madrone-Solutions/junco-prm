// Written before the schemas change, so a later "fix" in the wrong direction
// is caught. Each of these is a call that works today and must keep working.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { addContact } from "../src/tools/attributes";
import { logEncounter } from "../src/tools/encounters";
import { listRecords } from "../src/tools/export";
import { createFollowup } from "../src/tools/followups";
import { createPerson } from "../src/tools/people";

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

describe("behaviours the schemas must be made to agree with", () => {
  it("list_records defaults scope to people when omitted", async () => {
    const result = await listRecords(ctx, {} as never);
    expect(result.scope).toBe("people");
  });

  it("log_encounter defaults occurred_on to the owner's local date, not the UTC date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "met" } as never);
    // The clock is 2026-08-21T02:30:00Z, which is still 2026-08-20 in
    // America/Los_Angeles. Asserting the specific date, not just its shape,
    // catches a default that used the UTC date or the wrong time zone.
    expect(encounter.occurred_on).toBe("2026-08-20");
  });

  it("add_contact accepts a null label and stores it as null", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const updated = await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "a@b.test",
      label: null,
    });
    // Found by value rather than assumed to be contacts[0]: a person can
    // carry several contacts.
    const contact = updated.contacts.find((c) => c.value === "a@b.test");
    expect(contact?.label).toBeNull();
  });

  it("log_encounter accepts null location and event and stores them as null", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, {
      person_id: person.id,
      occurred_on: "2026-08-27",
      summary: "x",
      location: null,
      event: null,
    });
    expect(encounter.location).toBeNull();
    expect(encounter.event).toBeNull();
  });

  it("create_followup accepts a null note and stores it as null", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await createFollowup(ctx, {
      person_id: person.id,
      due_on: "2026-09-09",
      note: null,
    });
    expect(followup.note).toBeNull();
  });
});
