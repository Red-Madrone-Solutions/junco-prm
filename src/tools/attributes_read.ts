import type { ToolContext } from "../context";
import type { Contact, Link } from "../types";

export async function loadContacts(ctx: ToolContext, personId: string): Promise<Contact[]> {
  const { results } = await ctx.db
    .prepare(
      "SELECT id, contact_type, value, label FROM person_contacts WHERE person_id = ? ORDER BY created_at, id"
    )
    .bind(personId)
    .all<Contact>();
  return results;
}

export async function loadLinks(ctx: ToolContext, personId: string): Promise<Link[]> {
  const { results } = await ctx.db
    .prepare("SELECT id, link_type, url FROM person_links WHERE person_id = ? ORDER BY created_at, id")
    .bind(personId)
    .all<Link>();
  return results;
}

export async function loadTags(ctx: ToolContext, personId: string): Promise<string[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT t.name AS name FROM person_tags pt
       JOIN tags t ON t.id = pt.tag_id
       WHERE pt.person_id = ? ORDER BY t.name`
    )
    .bind(personId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}
