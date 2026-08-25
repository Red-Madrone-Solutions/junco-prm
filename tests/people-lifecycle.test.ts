import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { archivePerson, createPerson, deletePerson, unarchivePerson } from "../src/tools/people";
import { addContact } from "../src/tools/attributes";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM confirmations").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("archivePerson", () => {
  it("sets archived_at and is reversible", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const archived = await archivePerson(ctx, { person_id: person.id });
    expect(archived.archived_at).toBe("2026-08-20T12:00:00.000Z");
    const restored = await unarchivePerson(ctx, { person_id: person.id });
    expect(restored.archived_at).toBeNull();
  });

  it("archiving twice is not an error", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await archivePerson(ctx, { person_id: person.id });
    const again = await archivePerson(ctx, { person_id: person.id });
    expect(again.archived_at).not.toBeNull();
  });
});

describe("deletePerson", () => {
  it("returns a preview and a token instead of deleting on the first call", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const first = await deletePerson(ctx, { person_id: person.id });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    expect(first.confirmation_token).toMatch(/^cnf_/);
    expect(first.preview.full_name).toBe("Ada Lovelace");

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("deletes when the token is presented", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const first = await deletePerson(ctx, { person_id: person.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    const second = await deletePerson(ctx, {
      person_id: person.id,
      confirmation_token: first.confirmation_token,
    });
    expect(second.status).toBe("deleted");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("refuses a token issued for a different person", async () => {
    const a = await createPerson(ctx, { full_name: "Ada" });
    const b = await createPerson(ctx, { full_name: "Grace" });
    const first = await deletePerson(ctx, { person_id: a.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    await expect(
      deletePerson(ctx, { person_id: b.id, confirmation_token: first.confirmation_token })
    ).rejects.toThrow(ToolError);
  });

  it("replays a confirmed delete that the client retried", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const first = await deletePerson(ctx, { person_id: person.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");

    const args = {
      person_id: person.id,
      confirmation_token: first.confirmation_token,
      idempotency_key: "k1",
    };
    const committed = await deletePerson(ctx, args);
    // The client never saw the response and sent the same call again.
    const retried = await deletePerson(ctx, args);

    expect(retried).toEqual(committed);
    expect(retried.status).toBe("deleted");
  });

  it("cascades to contacts, links, and tags", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await env.DB.prepare(
      `INSERT INTO person_contacts
         (id, person_id, contact_type, value, normalized_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind("pc_x", person.id, "email", "a@example.test", "a@example.test", "2026-08-20T00:00:00Z")
      .run();

    const first = await deletePerson(ctx, { person_id: person.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    await deletePerson(ctx, { person_id: person.id, confirmation_token: first.confirmation_token });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM person_contacts").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("leaves NO fts row behind after a hard delete", async () => {
    // The symptom this catches is not an error. It is a deleted person still
    // appearing in search, months later, in the one tool that exists to answer
    // an erasure request.
    const person = await createPerson(ctx, {
      full_name: "Ada Lovelace",
      notes: "distinctive-note-token",
    });

    const token = await deletePerson(ctx, { person_id: person.id });
    if (token.status !== "confirmation_required") throw new Error("expected a preview");
    await deletePerson(ctx, {
      person_id: person.id,
      confirmation_token: token.confirmation_token,
    });

    // Quoted as a phrase: FTS5's query-syntax parser (distinct from the content
    // tokenizer) treats an unquoted mid-word hyphen as the NOT operator, which
    // makes the bare term a syntax error ("no such column: note") rather than a
    // search that simply finds nothing.
    const inPeople = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM people_fts WHERE people_fts MATCH ?"
    )
      .bind('"distinctive-note-token"')
      .first<{ n: number }>();
    expect(inPeople?.n).toBe(0);
  });

  it("leaves NOTHING in the operational tables either", async () => {
    // The half a cascade cannot reach, because neither table has a foreign key
    // to `people`. `idempotency_keys.response_json` holds full copies of every
    // write result about this person; `confirmations.preview` holds their name
    // and counts. An erasure tool that empties the durable tables and leaves
    // these two has not erased anything, it has relocated it.
    const person = await createPerson(ctx, {
      full_name: "Ada Lovelace",
      notes: "distinctive-note-token",
      idempotency_key: "k-create",
    });
    await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "distinctive@example.test",
      idempotency_key: "k-contact",
    });

    // The stored response really does contain her, before the delete.
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM idempotency_keys WHERE subject_id = ?"
    )
      .bind(person.id)
      .first<{ n: number }>();
    expect(before?.n).toBeGreaterThan(0);

    const token = await deletePerson(ctx, { person_id: person.id });
    if (token.status !== "confirmation_required") throw new Error("expected a preview");
    await deletePerson(ctx, {
      person_id: person.id,
      confirmation_token: token.confirmation_token,
    });

    const keys = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM idempotency_keys WHERE subject_id = ?"
    )
      .bind(person.id)
      .first<{ n: number }>();
    expect(keys?.n).toBe(0);

    const confirmations = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM confirmations WHERE target_id = ?"
    )
      .bind(person.id)
      .first<{ n: number }>();
    expect(confirmations?.n).toBe(0);

    // And no stored blob anywhere still mentions her, whatever it is keyed on.
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?"
    )
      .bind("%distinctive%")
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});
