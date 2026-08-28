// tests/validation-boundary.test.ts
//
// Every test goes through the MCP tools/call boundary on purpose. The defect
// being fixed is that unknown arguments reach the handler and are ignored by
// property access, which is invisible to any test calling a tool directly.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { callTool } from "./helpers/rpc";
import { TOOLS } from "../src/tools/index";

async function countPeople(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
  return row?.n ?? 0;
}

async function idempotencyKeyExists(key: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = ?")
    .bind(key)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

describe("the defect: unknown arguments are dropped", () => {
  // THE REPORTED BUG, ORIGINALLY. A caller passed `cursor` to search_people,
  // which at the time declared people_cursor and roster_cursor and no cursor.
  // The argument was dropped, the query restarted, and the identical page and
  // identical token came back. Filed as a pagination defect. Pagination was
  // correct. Task 4 gave search_people a real `cursor` field and retired
  // people_cursor and roster_cursor, so this test now demonstrates the same
  // defect shape with those retired names instead.
  it("refuses an unknown argument instead of ignoring it", async () => {
    const { isError, payload } = await callTool("search_people", {
      query: "Mark",
      people_cursor: "eyJraW5kIjoi",
    });
    expect(isError).toBe(true);
    expect(payload.error.code).toBe("invalid_input");
    expect(payload.error.reason).toContain("people_cursor");
  });

  it("names what it would have accepted", async () => {
    const { payload } = await callTool("search_people", { query: "Mark", people_cursor: "x" });
    expect(payload.error.reason).toMatch(/cursor/);
  });

  it("refuses an unknown argument on a write without writing", async () => {
    const spy = vi.spyOn(TOOLS.create_person!, "run");
    const before = await countPeople();
    const { isError } = await callTool("create_person", {
      full_name: "Ada Lovelace",
      idempotency_key: "boundary-test-1",
      nonsense_field: "x",
    });
    expect(isError).toBe(true);
    // The handler must not run at all. Counting rows alone would pass even if
    // the handler ran and happened to fail after claiming a key.
    expect(spy).not.toHaveBeenCalled();
    expect(await countPeople()).toBe(before);
    // And the key must be reclaimable. A claim recorded for a call that never
    // produced a result is a key that can never replay.
    expect(await idempotencyKeyExists("boundary-test-1")).toBe(false);
    spy.mockRestore();
  });
});

describe("refusals that already work, and must keep working", () => {
  // These pass BEFORE the validator exists, because the handlers validate
  // internally: search.ts:198 for query type, export.ts:85 for the scope enum.
  // They are here as regression guards, not as reproductions of the defect.
  it("refuses a wrong-typed query", async () => {
    const { payload } = await callTool("search_people", { query: 42 });
    expect(payload.error.code).toBe("invalid_input");
  });

  it("refuses a scope outside the enum", async () => {
    const { payload } = await callTool("list_records", { scope: "toString" });
    expect(payload.error.code).toBe("invalid_input");
  });

  // THE CONTRACT THE VALIDATOR MUST NOT BREAK. src/ids.ts distinguishes a
  // malformed id from a bad argument, and tests/mcp.test.ts's "maps an id of
  // the wrong kind to invalid_id, not to a crash" depends on it. A validator
  // enforcing the ^p_ pattern would return invalid_input here.
  it("still reports invalid_id for an id of the wrong kind", async () => {
    const { payload } = await callTool("log_encounter", {
      person_id: "re_1",
      occurred_on: "2026-08-20",
      summary: "x",
    });
    expect(payload.error.code).toBe("invalid_id");
  });
});

describe("calls that must keep succeeding", () => {
  // Without these, "refuse everything" passes every negative test above.
  it("accepts a valid call", async () => {
    const { isError } = await callTool("search_people", { query: "nobody-by-this-name" });
    expect(isError).toBe(false);
  });

  it("accepts a valid call that omits every optional argument", async () => {
    const { isError } = await callTool("list_records", {});
    expect(isError).toBe(false);
  });

  it("accepts null for a property the handler treats as nullable", async () => {
    const created = await callTool("create_person", { full_name: "Grace Hopper" });
    const { isError } = await callTool("update_person", {
      person_id: created.payload.id,
      job_title: null,
    });
    expect(isError).toBe(false);
  });
});
