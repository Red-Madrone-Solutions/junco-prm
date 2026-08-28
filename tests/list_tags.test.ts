import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { addTags, removeTags } from "../src/tools/attributes";
import { listTags } from "../src/tools/list_tags";
import { archivePerson, createPerson } from "../src/tools/people";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00.250Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM tags").run();
});

describe("listTags", () => {
  it("returns each tag with a count of the people carrying it", async () => {
    const a = await createPerson(ctx, { full_name: "A" });
    const b = await createPerson(ctx, { full_name: "B" });
    await addTags(ctx, { person_id: a.id, tags: ["speaker"] });
    await addTags(ctx, { person_id: b.id, tags: ["speaker"] });
    const result = await listTags(ctx, {});
    expect(result.tags).toContainEqual({ name: "speaker", people_count: 2 });
  });

  // removeTags never deletes the tags row, and delete_person cascades
  // person_tags but not tags, so orphans accumulate. Showing them is the point:
  // spotting "speaker" beside "speakers" is what this tool is for, and an inner
  // join would hide exactly the rows worth seeing.
  it("includes tags nobody currently carries", async () => {
    const p = await createPerson(ctx, { full_name: "A" });
    await addTags(ctx, { person_id: p.id, tags: ["orphan"] });
    await removeTags(ctx, { person_id: p.id, tags: ["orphan"] });
    const result = await listTags(ctx, {});
    expect(result.tags).toContainEqual({ name: "orphan", people_count: 0 });
  });

  // A count that silently includes archived people is a wrong number, and
  // list_records and search_people already disagree about archived by default.
  it("does not count archived people", async () => {
    const p = await createPerson(ctx, { full_name: "A" });
    await addTags(ctx, { person_id: p.id, tags: ["speaker"] });
    await archivePerson(ctx, { person_id: p.id });
    const result = await listTags(ctx, {});
    expect(result.tags).toContainEqual({ name: "speaker", people_count: 0 });
  });
});
