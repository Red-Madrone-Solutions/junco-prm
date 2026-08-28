// Written before the schemas change, so a later "fix" in the wrong direction
// is caught. Each of these is a call that works today and must keep working.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { addContact } from "../src/tools/attributes";
import { logEncounter } from "../src/tools/encounters";
import { exportData as listOrExport } from "../src/tools/export";
import { createFollowup } from "../src/tools/followups";
import { createPerson } from "../src/tools/people";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-27T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("behaviours the schemas must be made to agree with", () => {
  it("export_data defaults scope to people when omitted", async () => {
    const result = await listOrExport(ctx, {} as never);
    expect(result.scope).toBe("people");
  });

  it("log_encounter defaults occurred_on to today when omitted", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "met" } as never);
    expect(encounter.occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("add_contact accepts a null label", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      addContact(ctx, { person_id: person.id, contact_type: "email", value: "a@b.test", label: null })
    ).resolves.toBeTruthy();
  });

  it("log_encounter accepts null location and event", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      logEncounter(ctx, { person_id: person.id, occurred_on: "2026-08-27", summary: "x", location: null, event: null })
    ).resolves.toBeTruthy();
  });

  it("create_followup accepts a null note", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      createFollowup(ctx, { person_id: person.id, due_on: "2026-09-09", note: null })
    ).resolves.toBeTruthy();
  });
});
