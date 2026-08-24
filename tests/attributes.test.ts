import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import { addContact, addLink, addTags, removeContact, removeTags } from "../src/tools/attributes";
import { createPerson, getPerson } from "../src/tools/people";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM tags").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("contacts", () => {
  it("adds an email and returns the whole person", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const detail = await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "ada@example.test",
    });
    expect(detail.id).toBe(person.id);
    expect(detail.contacts).toEqual([
      expect.objectContaining({ contact_type: "email", value: "ada@example.test" }),
    ]);
  });

  it("is idempotent on the same value without needing a key", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addContact(ctx, { person_id: person.id, contact_type: "email", value: "a@example.test" });
    const detail = await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "a@example.test",
    });
    expect(detail.contacts).toHaveLength(1);
  });

  it("rejects an unknown contact_type", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      addContact(ctx, { person_id: person.id, contact_type: "fax" as never, value: "x" })
    ).rejects.toThrow(ToolError);
  });

  it("removes a contact by its prefixed id", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const added = await addContact(ctx, {
      person_id: person.id,
      contact_type: "phone",
      value: "+1-555-0100",
    });
    const first = added.contacts[0];
    if (first === undefined) throw new Error("addContact returned no contact");
    const contactId = first.id;
    expect(contactId).toMatch(/^pc_/);
    const after = await removeContact(ctx, { person_id: person.id, contact_id: contactId });
    expect(after.contacts).toEqual([]);
  });

  it("rejects a person id where a contact id belongs", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      removeContact(ctx, { person_id: person.id, contact_id: newId("p") })
    ).rejects.toThrow(ToolError);
  });
});

describe("links", () => {
  it("stores websites and social profiles in one table typed by link_type", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addLink(ctx, { person_id: person.id, link_type: "website", url: "https://example.test" });
    const detail = await addLink(ctx, {
      person_id: person.id,
      link_type: "mastodon",
      url: "https://mas.to/@ada",
    });
    expect(detail.links).toHaveLength(2);
    expect(detail.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ link_type: "website" }),
        expect.objectContaining({ link_type: "mastodon" }),
      ])
    );
  });
});

describe("tags", () => {
  it("adds tags, creating them on first use", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const detail = await addTags(ctx, { person_id: person.id, tags: ["wcus", "follow-up"] });
    expect(detail.tags.sort()).toEqual(["follow-up", "wcus"]);
  });

  it("APPENDS rather than replacing, which is the whole reason set_tags is gone", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const detail = await addTags(ctx, { person_id: person.id, tags: ["follow-up"] });
    expect(detail.tags.sort()).toEqual(["follow-up", "wcus"]);
  });

  it("removes only the named tags and leaves the rest", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus", "follow-up", "speaker"] });
    const detail = await removeTags(ctx, { person_id: person.id, tags: ["follow-up"] });
    expect(detail.tags.sort()).toEqual(["speaker", "wcus"]);
  });

  it("adding a tag the person already has is a no-op, not an error", async () => {
    // An agent that re-reads a transcript and re-issues a call must not fail.
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const detail = await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    expect(detail.tags).toEqual(["wcus"]);
  });

  it("removing a tag the person does not have is a no-op, not an error", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const detail = await removeTags(ctx, { person_id: person.id, tags: ["nope"] });
    expect(detail.tags).toEqual(["wcus"]);
  });

  it("leaves the tag row in place when the last person is untagged", async () => {
    // Tags are a vocabulary, not a per-person attribute. Deleting the row when
    // its last holder drops it would make the tag disappear from any future
    // vocabulary listing the moment it is briefly unused.
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    await removeTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("reuses an existing tag row across people", async () => {
    const a = await createPerson(ctx, { full_name: "Ada" });
    const b = await createPerson(ctx, { full_name: "Grace" });
    await addTags(ctx, { person_id: a.id, tags: ["wcus"] });
    await addTags(ctx, { person_id: b.id, tags: ["wcus"] });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("normalizes tag names to lowercase and trims them", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const detail = await addTags(ctx, { person_id: person.id, tags: ["  WCUS  ", "wcus"] });
    expect(detail.tags).toEqual(["wcus"]);
  });

  it("matches on the normalized form when removing", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const detail = await removeTags(ctx, { person_id: person.id, tags: ["  WCUS "] });
    expect(detail.tags).toEqual([]);
  });
});

describe("getPerson", () => {
  it("returns the collections the earlier task stubbed", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addContact(ctx, { person_id: person.id, contact_type: "email", value: "a@example.test" });
    await addTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const detail = await getPerson(ctx, { person_id: person.id });
    expect(detail.contacts).toHaveLength(1);
    expect(detail.tags).toEqual(["wcus"]);
  });
});
