import type { ToolContext } from "../context";

/**
 * No cursor and no limit, deliberately. A personal relationship manager's tag
 * vocabulary is tens of entries, and this tool exists to show all of it so
 * near-duplicates are visible at a glance. An earlier draft declared cursor
 * and limit here and registered neither, which is a contract the tool did not
 * honour.
 */
export interface ListTagsInput {}

export async function listTags(ctx: ToolContext, input: ListTagsInput) {
  // LEFT JOIN, not INNER: a tag nobody carries is exactly what makes this
  // useful as a hygiene tool. Archived people are excluded from the count
  // rather than from the tag, so the tag still appears with a lower number.
  const rows = await ctx.db
    .prepare(
      `SELECT t.name AS name,
              COUNT(p.id) AS people_count
       FROM tags t
       LEFT JOIN person_tags pt ON pt.tag_id = t.id
       LEFT JOIN people p ON p.id = pt.person_id AND p.archived_at IS NULL
       GROUP BY t.id, t.name
       ORDER BY t.name`
    )
    .all<{ name: string; people_count: number }>();
  return { tags: rows.results.map((r) => ({ name: r.name, people_count: Number(r.people_count) })) };
}
