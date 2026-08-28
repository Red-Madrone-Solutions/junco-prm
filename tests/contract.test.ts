import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import { TOOLS } from "../src/tools/index";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

/**
 * All 30, sorted. The spec counts its own surface and so does this list: the
 * previous draft's registry had 26, carrying `set_tags` where the spec has
 * `add_tags` and `remove_tags`, and no `get_roster_entry` at all. Task 1 of
 * the read-surface plan added `update_followup`, bringing the count from 28
 * to 29. Task 4 split `search_people` into `search_people` and
 * `search_roster_entries`, bringing the count to 30.
 */
const EXPECTED = [
  "add_contact",
  "add_link",
  "add_tags",
  "archive_person",
  "cancel_followup",
  "complete_followup",
  "create_followup",
  "create_person",
  "delete_encounter",
  "delete_person",
  "finalize_import",
  "get_person",
  "get_roster_entry",
  "import_roster",
  "list_due",
  "list_encounters",
  "list_records",
  "list_roster_sources",
  "log_encounter",
  "promote_roster_entry",
  "purge_roster_source",
  "remove_contact",
  "remove_link",
  "remove_tags",
  "search_people",
  "search_roster_entries",
  "unarchive_person",
  "update_encounter",
  "update_followup",
  "update_person",
];

describe("tool registry", () => {
  it("exposes exactly the expected tools, in both directions", () => {
    expect(Object.keys(TOOLS).sort()).toEqual(EXPECTED);
  });

  it("has 30 of them, after task 4's search_roster_entries split", () => {
    expect(Object.keys(TOOLS)).toHaveLength(30);
  });

  it("carries no tool name the fifth spec revision renamed away", () => {
    // Each of these was in the previous draft's registry and is now wrong.
    for (const gone of ["set_tags", "promote", "set_followup"]) {
      expect(Object.keys(TOOLS), `${gone} is still registered`).not.toContain(gone);
    }
  });

  it("gives every tool a real description", () => {
    // `tool.name` is not checked against its registry key here: TOOLS is built
    // by `.map((tool) => [tool.name, tool])` (src/tools/index.ts), so the key
    // is derived from `tool.name` itself and the two can never disagree - that
    // would be vacuous. A `define(...)` call given the wrong name is instead
    // caught by "exposes exactly the expected tools, in both directions"
    // above, which compares TOOLS against EXPECTED, a hardcoded, independent
    // list.
    for (const tool of Object.values(TOOLS)) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("gives every tool a usable input schema", () => {
    for (const tool of Object.values(TOOLS)) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      for (const field of tool.inputSchema.required ?? []) {
        expect(
          Object.keys(tool.inputSchema.properties),
          `${tool.name} requires ${field} but does not declare it`
        ).toContain(field);
      }
      for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
        expect((schema as { description?: string }).description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("declares idempotency_key on every write", () => {
    // `get_roster_entry` is excluded alongside the other reads even though its
    // name does not start with list_/search_/get_person: it is a plain SELECT
    // (see roster_admin.ts), and the registry correctly gives it no
    // idempotency_key. The brief's own filter omitted it - see the task 16
    // report.
    const writes = EXPECTED.filter(
      (name) => !name.startsWith("list_") && !name.startsWith("search_") &&
        name !== "get_person" && name !== "list_records" && name !== "get_roster_entry"
    );
    for (const name of writes) {
      const tool = TOOLS[name];
      expect(
        Object.keys(tool?.inputSchema.properties ?? {}),
        `${name} does not accept an idempotency_key`
      ).toContain("idempotency_key");
    }
  });

  it("declares all three MCP annotations on every tool", () => {
    for (const tool of Object.values(TOOLS)) {
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations.idempotentHint, tool.name).toBe("boolean");
    }
  });

  it("marks exactly the reads read-only", () => {
    const readOnly = Object.values(TOOLS)
      .filter((t) => t.annotations.readOnlyHint)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual([
      "get_person",
      "get_roster_entry",
      "list_due",
      "list_encounters",
      "list_records",
      "list_roster_sources",
      "search_people",
      "search_roster_entries",
    ]);
  });

  it("marks exactly the removing AND overwriting operations destructive", () => {
    // MCP defines destructiveHint: false as "performs only additive updates",
    // and the doc comment on ToolAnnotations says the same thing in its own
    // words: an UPDATE counts, an INSERT does not. update_person overwrites
    // `notes` and update_encounter overwrites `summary` - the previous text is
    // gone and nothing retains it - so neither is additive. Both were annotated
    // false, which let a client auto-approve destroying a note the user wrote.
    // add_contact, add_link and add_tags are genuinely additive and stay false.
    const destructive = Object.values(TOOLS)
      .filter((t) => t.annotations.destructiveHint)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual([
      "delete_encounter",
      "delete_person",
      "purge_roster_source",
      "remove_contact",
      "remove_link",
      "remove_tags",
      "update_encounter",
      "update_followup",
      "update_person",
    ]);
  });

  it("never marks a tool both read-only and destructive", () => {
    for (const tool of Object.values(TOOLS)) {
      expect(
        tool.annotations.readOnlyHint && tool.annotations.destructiveHint,
        `${tool.name} claims to be both`
      ).toBe(false);
    }
  });

  it("marks the two record-creating writes as NOT idempotent", () => {
    // A second log_encounter with the same arguments is a second encounter,
    // and that is correct: someone met twice in one day. The idempotency_key
    // is what makes a RETRY safe, which is a different question.
    for (const name of ["create_person", "log_encounter", "create_followup"]) {
      expect(TOOLS[name]?.annotations.idempotentHint, name).toBe(false);
    }
  });

  it("RETURNS `today` FROM EVERY TOOL, read and write alike", async () => {
    // The envelope is applied at the registry seam so no tool can forget it.
    // This is the test that keeps it that way when a 29th tool is added.
    const person = await TOOLS.create_person!.run(ctx, { full_name: "Ada Lovelace" } as never);
    const found = await TOOLS.search_people!.run(ctx, { query: "Lovelace" } as never);
    const due = await TOOLS.list_due!.run(ctx, {} as never);
    const sources = await TOOLS.list_roster_sources!.run(ctx, {} as never);

    for (const result of [person, found, due, sources]) {
      expect(result).toHaveProperty("today");
      expect((result as { today: string }).today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("reports `today` in the OWNER'S zone, not UTC", async () => {
    // "Follow up tomorrow," dictated at 11pm Pacific, is wrong for a third of
    // every day if the model assumes the server's clock.
    const pacific: ToolContext = {
      ...ctx,
      timezone: "America/Los_Angeles",
      clock: () => new Date("2026-08-21T05:00:00Z"), // 10pm on the 20th, Pacific
    };
    const result = await TOOLS.list_due!.run(pacific, {} as never);
    expect((result as { today: string }).today).toBe("2026-08-20");
  });

  it("RECORDS THE SUBJECT on every person-scoped write", async () => {
    // An omission here is invisible until someone exercises their right to be
    // erased, at which point delete_person quietly leaves a full copy of them
    // in idempotency_keys.response_json. That is the one failure this whole
    // column exists to prevent, so it is asserted per tool rather than spot-
    // checked.
    const person = await TOOLS.create_person!.run(ctx, {
      full_name: "Ada Lovelace",
    } as never) as { id: string };

    const calls: [string, Record<string, unknown>][] = [
      ["update_person", { person_id: person.id, job_title: "Engineer" }],
      ["archive_person", { person_id: person.id }],
      ["unarchive_person", { person_id: person.id }],
      ["add_contact", { person_id: person.id, contact_type: "email", value: "a@example.test" }],
      ["add_link", { person_id: person.id, link_type: "website", url: "https://example.test" }],
      ["add_tags", { person_id: person.id, tags: ["wcus"] }],
      ["remove_tags", { person_id: person.id, tags: ["wcus"] }],
      ["log_encounter", { person_id: person.id, occurred_on: "2026-08-20", summary: "met" }],
      ["create_followup", { person_id: person.id, due_on: "2026-08-25", note: "deck" }],
    ];

    for (const [name, input] of calls) {
      const key = `subj-${name}`;
      await TOOLS[name]!.run(ctx, { ...input, idempotency_key: key } as never);

      const row = await env.DB.prepare(
        "SELECT subject_id FROM idempotency_keys WHERE key = ?"
      )
        .bind(`${name}:${key}`)
        .first<{ subject_id: string | null }>();

      expect(row, `${name} recorded no idempotency row at all`).toBeTruthy();
      expect(row?.subject_id, `${name} did not record its subject`).toBe(person.id);
    }
  });

  it("records NO subject on tools that are not about one person", async () => {
    // A source_key distinct from the "wcus-2026" fixture every other test file
    // reuses. This suite shares one D1 instance across files with no isolation
    // between them (vitest.config.ts: isolate: false), and a prior file's run
    // can leave that key purged, which import_roster refuses to import into.
    await TOOLS.import_roster!.run(ctx, {
      source_key: "task16-contract-subject-check",
      label: "Task 16 contract check",
      source_url: "https://example.test",
      format: "json",
      expected_total: 1,
      rows: [{ external_row_key: "1", full_name: "Grace Hopper" }],
      idempotency_key: "subj-import",
    } as never);

    const row = await env.DB.prepare(
      "SELECT subject_id FROM idempotency_keys WHERE key = ?"
    )
      .bind("import_roster:subj-import")
      .first<{ subject_id: string | null }>();
    expect(row?.subject_id).toBeNull();
  });

  it("declares every field the encounter tools validate and store", () => {
    // The one dimension the earlier break-then-revert proofs never covered was
    // schema STRUCTURE, and it was the dimension that had a defect in it.
    // logEncounter and updateEncounter both validate `occurred_at` as an ISO
    // instant and write it to a column migration 0005 declares, while neither
    // schema declared it and both declare additionalProperties: false. It
    // worked only because nothing enforces the schema yet; a conforming client
    // could never have written that column.
    const fields: [string, string[]][] = [
      [
        "log_encounter",
        ["person_id", "occurred_on", "occurred_at", "summary", "location", "event", "idempotency_key"],
      ],
      [
        "update_encounter",
        ["encounter_id", "occurred_on", "occurred_at", "summary", "location", "event", "idempotency_key"],
      ],
    ];
    for (const [name, expected] of fields) {
      const tool = TOOLS[name];
      if (!tool) throw new Error(`no tool ${name}`);
      expect(Object.keys(tool.inputSchema.properties).sort(), name).toEqual([...expected].sort());
      expect(tool.inputSchema.additionalProperties, name).toBe(false);
    }
  });

  it("stores an occurred_at sent through the registry, the field the schemas now declare", async () => {
    // The other half of the pair above: the schema permits it AND the code
    // honours it. Either half alone can be true while the contract is broken.
    const person = (await TOOLS["create_person"]!.run(ctx, {
      full_name: "Ada Lovelace",
    } as never)) as { id: string };

    const logged = (await TOOLS["log_encounter"]!.run(ctx, {
      person_id: person.id,
      occurred_on: "2026-08-20",
      occurred_at: "2026-08-20T18:00:00Z",
      summary: "met at the hallway track",
    } as never)) as { encounter: { id: string; occurred_at: string | null } };
    expect(logged.encounter.occurred_at).toBe("2026-08-20T18:00:00Z");

    const fixed = (await TOOLS["update_encounter"]!.run(ctx, {
      encounter_id: logged.encounter.id,
      occurred_at: "2026-08-20T19:30:00Z",
    } as never)) as { occurred_at: string | null };
    expect(fixed.occurred_at).toBe("2026-08-20T19:30:00Z");
  });

  it("does not resolve a tool name up the prototype chain", async () => {
    // Plan 2's transport will index this map by a name that arrives over the
    // wire. As a plain object literal, TOOLS["toString"] is a function and any
    // `=== undefined` guard on the lookup passes. The same shape was a live
    // defect in export.ts: `list_records({scope: "toString"})` (then still
    // named `export_data`) concatenated Function.prototype.toString's source
    // into the SQL.
    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(TOOLS[inherited], `TOOLS resolved ${inherited}`).toBeUndefined();
    }
    // The map still has to behave as a map.
    expect(Object.keys(TOOLS).sort()).toEqual(EXPECTED);
    expect(TOOLS["get_person"]?.name).toBe("get_person");
  });

  it("rejects a wrong-kind id from every tool that takes one", async () => {
    const wrongKind: [string, Record<string, unknown>][] = [
      ["get_person", { person_id: newId("re") }],
      ["update_person", { person_id: newId("re"), job_title: "x" }],
      ["archive_person", { person_id: newId("enc") }],
      ["unarchive_person", { person_id: newId("enc") }],
      ["delete_person", { person_id: newId("re") }],
      ["add_contact", { person_id: newId("re"), contact_type: "email", value: "a@example.test" }],
      ["remove_contact", { person_id: newId("re"), contact_id: newId("pc") }],
      ["add_link", { person_id: newId("re"), link_type: "website", url: "https://example.test" }],
      ["remove_link", { person_id: newId("re"), link_id: newId("pl") }],
      ["add_tags", { person_id: newId("re"), tags: ["x"] }],
      ["remove_tags", { person_id: newId("re"), tags: ["x"] }],
      ["log_encounter", { person_id: newId("re"), summary: "x" }],
      ["update_encounter", { encounter_id: newId("p"), summary: "x" }],
      ["delete_encounter", { encounter_id: newId("p") }],
      ["create_followup", { person_id: newId("re"), due_on: "2026-08-25" }],
      ["complete_followup", { followup_id: newId("p") }],
      ["cancel_followup", { followup_id: newId("p") }],
      ["finalize_import", { run_id: newId("rs") }],
      ["promote_roster_entry", { roster_entry_id: newId("p") }],
      ["get_roster_entry", { roster_entry_id: newId("p") }],
      ["purge_roster_source", { roster_source_id: newId("p") }],
    ];

    for (const [name, input] of wrongKind) {
      const tool = TOOLS[name];
      if (!tool) throw new Error(`no tool ${name}`);
      // ASSERTING THE CODE, NOT THE CLASS, and that is the whole test.
      // Ids carry a UUID and are unique across every table, so a p_ id simply
      // matches no roster source - every tool here throws `not_found` on a
      // wrong-kind id even with the prefix check removed from assertId
      // entirely. Proven: deleting that check passed all 16 contract tests, and
      // dropping assertId from purge_roster_source alone passed all 330. What
      // the discipline actually buys is the `invalid_id` code and the
      // corrective next call that tells a model to promote the roster entry
      // first, and only this assertion binds to it.
      let thrown: unknown;
      try {
        await tool.run(ctx, input as never);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${name} accepted a wrong-kind id`).toBeInstanceOf(ToolError);
      expect((thrown as ToolError).code, `${name} did not report invalid_id`).toBe("invalid_id");
    }
  });
});
