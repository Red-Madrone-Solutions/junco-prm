import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { normalizeEmail, normalizePhone, normalizeText } from "../normalize";
import { nowIso } from "../time";
import type { PersonDetail } from "../types";
import { getPerson, loadPerson } from "./people";

export type { Contact, Link } from "../types";

export interface AddContactInput {
  person_id: string;
  contact_type: "email" | "phone";
  value: string;
  label?: string | null;
  idempotency_key?: string;
}

export async function addContact(ctx: ToolContext, input: AddContactInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  const personId = assertId("p", input.person_id);
  return withIdempotency(ctx, "add_contact", idempotency_key, rest, async () => {
    if (input.contact_type !== "email" && input.contact_type !== "phone") {
      throw new ToolError("invalid_input", 'contact_type must be "email" or "phone"');
    }
    if (typeof input.value !== "string" || input.value.trim() === "") {
      throw new ToolError("invalid_input", "value is required");
    }
    await loadPerson(ctx, personId);

    // Two forms, both stored. `value` is what the user typed and what is read
    // back; `normalized_value` is what create_person's duplicate check and
    // search_people's "who is bob@example.test" both match on. Deriving the
    // second at query time would mean SQLite's ASCII-only LOWER() standing in
    // for NFKC, which is not the rule the rest of this codebase applies.
    const value = input.value.trim();
    const normalized =
      input.contact_type === "email" ? normalizeEmail(value) : normalizePhone(value);

    await ctx.db
      .prepare(
        `INSERT INTO person_contacts (id, person_id, contact_type, value, normalized_value, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (person_id, contact_type, normalized_value) DO NOTHING`
      )
      .bind(
        newId("pc"),
        personId,
        input.contact_type,
        value,
        normalized,
        input.label ?? null,
        nowIso(ctx.clock)
      )
      .run();

    return getPerson(ctx, { person_id: personId });
  }, personId);
}

export interface RemoveContactInput {
  person_id: string;
  contact_id: string;
  idempotency_key?: string;
}

export async function removeContact(ctx: ToolContext, input: RemoveContactInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  const personId = assertId("p", input.person_id);
  return withIdempotency(ctx, "remove_contact", idempotency_key, rest, async () => {
    const contactId = assertId("pc", input.contact_id);
    const result = await ctx.db
      .prepare("DELETE FROM person_contacts WHERE id = ? AND person_id = ?")
      .bind(contactId, personId)
      .run();
    if (result.meta.changes === 0) {
      throw new ToolError("not_found", `no contact ${contactId} on person ${personId}`);
    }
    return getPerson(ctx, { person_id: personId });
  }, personId);
}

export interface AddLinkInput {
  person_id: string;
  link_type: string;
  url: string;
  idempotency_key?: string;
}

export async function addLink(ctx: ToolContext, input: AddLinkInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  const personId = assertId("p", input.person_id);
  return withIdempotency(ctx, "add_link", idempotency_key, rest, async () => {
    if (typeof input.link_type !== "string" || input.link_type.trim() === "") {
      throw new ToolError("invalid_input", "link_type is required");
    }
    if (typeof input.url !== "string" || input.url.trim() === "") {
      throw new ToolError("invalid_input", "url is required");
    }
    await loadPerson(ctx, personId);

    await ctx.db
      .prepare(
        `INSERT INTO person_links (id, person_id, link_type, url, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (person_id, link_type, url) DO NOTHING`
      )
      .bind(newId("pl"), personId, input.link_type.trim(), input.url.trim(), nowIso(ctx.clock))
      .run();

    return getPerson(ctx, { person_id: personId });
  }, personId);
}

export interface RemoveLinkInput {
  person_id: string;
  link_id: string;
  idempotency_key?: string;
}

export async function removeLink(ctx: ToolContext, input: RemoveLinkInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  const personId = assertId("p", input.person_id);
  return withIdempotency(ctx, "remove_link", idempotency_key, rest, async () => {
    const linkId = assertId("pl", input.link_id);
    const result = await ctx.db
      .prepare("DELETE FROM person_links WHERE id = ? AND person_id = ?")
      .bind(linkId, personId)
      .run();
    if (result.meta.changes === 0) {
      throw new ToolError("not_found", `no link ${linkId} on person ${personId}`);
    }
    return getPerson(ctx, { person_id: personId });
  }, personId);
}

export interface TagsInput {
  person_id: string;
  tags: string[];
  idempotency_key?: string;
}

/**
 * Shared validation. Tag names are normalized with the same rules as every
 * other matched text in this codebase, so "  WCUS  " and "wcus" are one tag and
 * removing either removes it.
 */
function tagNames(input: TagsInput): string[] {
  if (!Array.isArray(input.tags)) {
    throw new ToolError("invalid_input", "tags must be an array of strings");
  }
  const names = [
    ...new Set(
      input.tags.map((t) => {
        if (typeof t !== "string") throw new ToolError("invalid_input", "tags must be strings");
        return normalizeText(t);
      })
    ),
  ].filter((t) => t !== "");
  if (names.length === 0) {
    throw new ToolError("invalid_input", "tags must contain at least one non-empty name");
  }
  return names;
}

/**
 * Adds without touching the tags already there.
 *
 * This replaced a `setTags` that wrote the whole set. With replace semantics an
 * agent adding one tag has to read the current set, append, and write it back,
 * and any tag added between the read and the write is silently destroyed. It
 * was also the only replace-semantics tool among three add/remove pairs, which
 * is exactly the inconsistency an LLM-first surface cannot afford.
 */
export async function addTags(ctx: ToolContext, input: TagsInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  const personId = assertId("p", input.person_id);
  return withIdempotency(ctx, "add_tags", idempotency_key, rest, async () => {
    const names = tagNames(input);
    await loadPerson(ctx, personId);

    const at = nowIso(ctx.clock);
    await ctx.db.batch(
      names.flatMap((name) => [
        ctx.db
          .prepare("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING")
          .bind(newId("tg"), name, at),
        // OR IGNORE, so re-adding a tag the person already has is a no-op
        // rather than a constraint violation. An agent that re-reads its own
        // transcript and re-issues a call must not fail.
        ctx.db
          .prepare(
            "INSERT OR IGNORE INTO person_tags (person_id, tag_id) SELECT ?, id FROM tags WHERE name = ?"
          )
          .bind(personId, name),
      ])
    );

    return getPerson(ctx, { person_id: personId });
  }, personId);
}

/**
 * Removes only the named tags. Removing one the person does not have is a no-op
 * rather than a `not_found`: the caller's intent is "make sure this tag is not
 * on her," and that intent is already satisfied.
 *
 * The `tags` row itself is never deleted, even when its last holder drops it.
 * Tags are a vocabulary rather than a per-person attribute, and a tag that
 * vanishes the moment it is briefly unused is a tag that disappears from any
 * future vocabulary listing.
 */
export async function removeTags(ctx: ToolContext, input: TagsInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  const personId = assertId("p", input.person_id);
  return withIdempotency(ctx, "remove_tags", idempotency_key, rest, async () => {
    const names = tagNames(input);
    await loadPerson(ctx, personId);

    const placeholders = names.map(() => "?").join(", ");
    await ctx.db
      .prepare(
        `DELETE FROM person_tags
          WHERE person_id = ?
            AND tag_id IN (SELECT id FROM tags WHERE name IN (${placeholders}))`
      )
      .bind(personId, ...names)
      .run();

    return getPerson(ctx, { person_id: personId });
  }, personId);
}
