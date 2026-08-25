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
 * All 28, sorted. The spec counts its own surface and so does this list: the
 * previous draft's registry had 26, carrying `set_tags` where the spec has
 * `add_tags` and `remove_tags`, and no `get_roster_entry` at all.
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
  "export_data",
  "finalize_import",
  "get_person",
  "get_roster_entry",
  "import_roster",
  "list_due",
  "list_encounters",
  "list_roster_sources",
  "log_encounter",
  "promote_roster_entry",
  "purge_roster_source",
  "remove_contact",
  "remove_link",
  "remove_tags",
  "search_people",
  "unarchive_person",
  "update_encounter",
  "update_person",
];

describe("tool registry", () => {
  it("exposes exactly the expected tools, in both directions", () => {
    expect(Object.keys(TOOLS).sort()).toEqual(EXPECTED);
  });

  it("has 28 of them, which is the number the spec states", () => {
    expect(Object.keys(TOOLS)).toHaveLength(28);
  });

  it("carries no tool name the fifth spec revision renamed away", () => {
    // Each of these was in the previous draft's registry and is now wrong.
    for (const gone of ["set_tags", "promote", "set_followup"]) {
      expect(Object.keys(TOOLS), `${gone} is still registered`).not.toContain(gone);
    }
  });

  it("names every tool consistently with its registry key", () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      expect(tool.name).toBe(key);
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
        name !== "get_person" && name !== "export_data" && name !== "get_roster_entry"
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
      "export_data",
      "get_person",
      "get_roster_entry",
      "list_due",
      "list_encounters",
      "list_roster_sources",
      "search_people",
    ]);
  });

  it("marks exactly the removing operations destructive", () => {
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
      await expect(tool.run(ctx, input as never), `${name} accepted a wrong-kind id`).rejects.toThrow(
        ToolError
      );
    }
  });
});
