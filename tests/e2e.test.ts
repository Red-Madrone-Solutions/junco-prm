import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { parseCsv } from "../src/tools/import_state";
import { TOOLS } from "../src/tools/index";
// Vite's ?raw import inlines the fixture at build time. Tests run inside workerd,
// which has no filesystem, so node:fs is not an option here.
import csv from "./fixtures/roster.csv?raw";

let now = new Date("2026-08-20T12:00:00Z");
const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => now,
};

function call(name: string, input: unknown): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(ctx, input as never);
}

beforeEach(async () => {
  now = new Date("2026-08-20T12:00:00Z");
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
});

describe("the conference path", () => {
  it("imports a roster, promotes someone, logs an encounter, and surfaces what is owed", async () => {
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(4);

    const imported = (await call("import_roster", {
      source_key: "wcus-2026",
      label: "WordCamp US 2026",
      event: "WCUS 2026",
      source_url: "https://example.test/attendees",
      format: "csv",
      expected_total: rows.length,
      rows,
    })) as { run_id: string; imported: number; remaining: number };

    expect(imported.imported).toBe(4);
    expect(imported.remaining).toBe(0);

    await call("finalize_import", { run_id: imported.run_id });

    // Find the roster entry the way an agent would.
    const found = (await call("search_people", { query: "Hopper", scope: "roster" })) as {
      people: unknown[];
      roster_entries: { id: string; record_kind: string; stale: boolean; promoted_person_id: string | null }[];
    };
    // Two arrays, always. Nothing this agent could do would put a roster entry
    // where it expects a person.
    expect(found.people).toEqual([]);
    expect(found.roster_entries).toHaveLength(1);
    expect(found.roster_entries[0]?.stale).toBe(false);
    expect(found.roster_entries[0]?.promoted_person_id).toBeNull();
    const entryId = found.roster_entries[0]?.id ?? "";
    expect(entryId).toMatch(/^re_/);

    // Read the row before promoting it. There is a tool for that now.
    const entry = (await call("get_roster_entry", { roster_entry_id: entryId })) as {
      full_name: string;
      source_label: string;
      promoted_person_id: string | null;
    };
    expect(entry.full_name).toBe("Grace Hopper");
    expect(entry.source_label).toBe("WordCamp US 2026");
    expect(entry.promoted_person_id).toBeNull();

    // Passing a roster id where a person id belongs is a validation error, not
    // a corrupted record. This is the failure the spec names as most likely.
    await expect(
      call("log_encounter", { person_id: entryId, occurred_on: "2026-08-20", summary: "x" })
    ).rejects.toThrow();

    // Phase one: candidates, no writes.
    const candidates = (await call("promote_roster_entry", { roster_entry_id: entryId })) as {
      status: string;
      content_hash: string;
      candidates: unknown[];
    };
    expect(candidates.status).toBe("candidates");
    expect(candidates.candidates).toEqual([]);
    expect(candidates.content_hash).toBeTruthy();

    // Phase two: commit, presenting the hash phase one saw.
    const promoted = (await call("promote_roster_entry", {
      roster_entry_id: entryId,
      create_new: true,
      expected_content_hash: candidates.content_hash,
    })) as { status: string; person: { id: string; contacts: { value: string }[] } };
    expect(promoted.status).toBe("promoted");
    const personId = promoted.person.id;
    expect(promoted.person.contacts[0]?.value).toBe("grace@example.test");

    // The same search now links the two arrays, so the agent can see the roster
    // row and the person it became without another call.
    const after = (await call("search_people", { query: "Hopper", scope: "all" })) as {
      people: { id: string }[];
      roster_entries: { promoted_person_id: string | null }[];
    };
    expect(after.people[0]?.id).toBe(personId);
    expect(after.roster_entries[0]?.promoted_person_id).toBe(personId);

    await call("log_encounter", {
      person_id: personId,
      occurred_on: "2026-08-20",
      summary: "Hallway track, talked about compilers.",
      event: "WCUS 2026",
      location: "Portland",
    });

    await call("add_tags", { person_id: personId, tags: ["wcus", "compilers"] });
    await call("remove_tags", { person_id: personId, tags: ["compilers"] });

    await call("create_followup", {
      person_id: personId,
      due_on: "2026-08-19",
      note: "Send the deck.",
    });

    const due = (await call("list_due", {})) as {
      results: { person_name: string; days_overdue: number }[];
      as_of: string;
      today: string;
    };
    expect(due.as_of).toBe("2026-08-20");
    // Every result carries the owner-zone date, applied at the registry seam.
    expect(due.today).toBe("2026-08-20");
    expect(due.results).toHaveLength(1);
    expect(due.results[0]?.person_name).toBe("Grace Hopper");
    expect(due.results[0]?.days_overdue).toBe(1);

    const detail = (await call("get_person", { person_id: personId })) as {
      encounter_count: number;
      open_followups: unknown[];
      sources: { source_key: string; matches_current: boolean | null }[];
      tags: string[];
    };
    expect(detail.encounter_count).toBe(1);
    expect(detail.open_followups).toHaveLength(1);
    expect(detail.tags).toEqual(["wcus"]);
    expect(detail.sources[0]?.source_key).toBe("wcus-2026");
    expect(detail.sources[0]?.matches_current).toBe(true);
    // Provenance METADATA. The snapshot is reachable only through the CLI
    // export in plan 3, because this result lands in a model's context
    // immediately before most writes against this person.
    expect(detail.sources[0]).not.toHaveProperty("raw_record_snapshot");
    expect(JSON.stringify(detail)).not.toContain("IGNORE");
  });

  it("re-imports with a corrected row: one row changes, nothing duplicates, nothing is lost", async () => {
    // The full round trip of the two-value key design, end to end, which is
    // invisible to any test that imports a roster only once.
    const rows = parseCsv(csv);
    const first = (await call("import_roster", {
      source_key: "wcus-2026",
      label: "WordCamp US 2026",
      source_url: "https://example.test/attendees",
      format: "csv",
      expected_total: rows.length,
      rows,
    })) as { run_id: string };
    await call("finalize_import", { run_id: first.run_id });

    // Promote Grace, so she has provenance pointing at her roster row.
    const found = (await call("search_people", { query: "Hopper", scope: "roster" })) as {
      roster_entries: { id: string }[];
    };
    const promoted = (await call("promote_roster_entry", {
      roster_entry_id: found.roster_entries[0]!.id,
      create_new: true,
    })) as { person: { id: string } };

    // September's roster: Grace has a corrected job title, and Chris Smith of
    // Studio B has left the list entirely.
    const september = rows
      .filter((r) => r.organization !== "Studio B")
      .map((r) => (r.full_name === "Grace Hopper" ? { ...r, job_title: "Rear Admiral" } : r));

    now = new Date("2026-09-20T12:00:00Z");
    const second = (await call("import_roster", {
      source_key: "wcus-2026",
      label: "WordCamp US 2026",
      source_url: "https://example.test/attendees",
      format: "csv",
      expected_total: september.length,
      rows: september,
    })) as { run_id: string; imported: number; updated: number };

    // Every row is an UPDATE. A corrected title is not a new person.
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(september.length);

    const finalized = (await call("finalize_import", { run_id: second.run_id })) as {
      total_entries: number;
      current: number;
      stale: number;
      promoted: number;
    };
    expect(finalized.total_entries).toBe(4); // nothing was deleted
    expect(finalized.current).toBe(3);
    expect(finalized.stale).toBe(1);
    expect(finalized.promoted).toBe(1);

    // The departed attendee is annotated, still searchable, still promotable.
    const gone = (await call("search_people", { query: "Chris Smith", scope: "roster" })) as {
      roster_entries: { organization: string; stale: boolean }[];
    };
    const departed = gone.roster_entries.find((r) => r.organization === "Studio B");
    expect(departed?.stale).toBe(true);

    // And Grace's provenance now reports that her roster row has moved under her.
    const detail = (await call("get_person", { person_id: promoted.person.id })) as {
      sources: { matches_current: boolean | null }[];
    };
    expect(detail.sources[0]?.matches_current).toBe(false);
  });

  it("keeps two people who share a name separate through import and promotion", async () => {
    const rows = parseCsv(csv);

    const imported = (await call("import_roster", {
      source_key: "wcus-2026",
      label: "WordCamp US 2026",
      source_url: "https://example.test/attendees",
      format: "csv",
      expected_total: rows.length,
      rows,
    })) as { run_id: string };
    await call("finalize_import", { run_id: imported.run_id });

    const found = (await call("search_people", { query: "Chris Smith", scope: "roster" })) as {
      roster_entries: { id: string }[];
    };
    expect(found.roster_entries).toHaveLength(2);

    for (const hit of found.roster_entries) {
      await call("promote_roster_entry", { roster_entry_id: hit.id, create_new: true });
    }

    const people = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(people?.n).toBe(2);

    const orgs = await env.DB.prepare(
      "SELECT organization FROM people ORDER BY organization"
    ).all<{ organization: string }>();
    expect(orgs.results.map((r) => r.organization)).toEqual(["Studio A", "Studio B"]);
  });
});
