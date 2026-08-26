import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools/index";

/**
 * Calls the MCP endpoint directly, bypassing OAuth by invoking the handler with
 * props the provider would have supplied. The OAuth flow itself is covered by
 * Task 5 and, end to end, by Task 9 against a real deployment.
 *
 * PROPS GO ON `ctx`, NOT `env`. workers-oauth-provider exposes a validated
 * grant's props as `ctx.props` (docs/MEASUREMENTS.md; src/auth/provider.ts's
 * own doc comment says the same), and `Env` (env.d.ts) has no `props` field at
 * all. An earlier draft of this helper spread `props` onto the second
 * argument instead - this docstring's own claim ("props the provider would
 * have supplied") was the tell, since the provider never puts them there.
 *
 * `props` IS NOT A DEFAULT PARAMETER, despite reading like one below. A default
 * parameter value substitutes on an explicit `undefined` argument as readily as
 * on an omitted one, so `rpc(method, params, undefined)` - the exact call the
 * "no props" test below makes - would silently fall back to the owner id and
 * test nothing. `arguments.length` is what tells "omitted" and "explicitly
 * undefined" apart.
 */
async function rpc(method: string, params: unknown, props?: unknown) {
  const effectiveProps = arguments.length >= 3 ? props : { githubUserId: "583231" };
  const { mcpHandler } = await import("../src/mcp/transport");
  const { loadConfig } = await import("../src/config");
  const handler = mcpHandler(loadConfig(env), "r1");
  const request = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const response = await handler.fetch!(
    request,
    env as never,
    { props: effectiveProps } as ExecutionContext
  );
  return { response, body: await response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
});

describe("tools/list", () => {
  it("advertises all 28 tools from the registry", async () => {
    const { body } = await rpc("tools/list", {});
    const tools = (body.result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(28);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
  });

  it("carries each tool's schema and description straight from the registry", async () => {
    const { body } = await rpc("tools/list", {});
    const tools = (body.result as { tools: { name: string; description: string; inputSchema: unknown }[] }).tools;
    for (const tool of tools) {
      expect(tool.description, tool.name).toBe(TOOLS[tool.name]!.description);
      expect(tool.inputSchema, tool.name).toEqual(TOOLS[tool.name]!.inputSchema);
    }
  });

  it("carries ALL THREE MCP annotations, which is why plan 1 built them", async () => {
    // Clients use these to decide what to approve and what to run without
    // asking. A surface this size should not make a client guess.
    const { body } = await rpc("tools/list", {});
    const tools = (body.result as { name: string; annotations: Record<string, boolean> }[] | { tools: { name: string; annotations: Record<string, boolean> }[] });
    const list = "tools" in tools ? tools.tools : tools;
    for (const tool of list) {
      const expected = TOOLS[tool.name]!.annotations;
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expected.readOnlyHint,
        destructiveHint: expected.destructiveHint,
        idempotentHint: expected.idempotentHint,
      });
    }
  });
});

describe("tools/call", () => {
  it("runs a tool and returns its result", async () => {
    const { body } = await rpc("tools/call", {
      name: "create_person",
      arguments: { full_name: "Ada Lovelace" },
    });
    const result = body.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const person = JSON.parse(result.content[0]!.text);
    expect(person.full_name).toBe("Ada Lovelace");
    expect(person.id).toMatch(/^p_/);
  });

  it("carries `today` through, in the OWNER'S zone", async () => {
    // Applied at plan 1's registry seam. This asserts it survives the transport.
    const { body } = await rpc("tools/call", { name: "list_due", arguments: {} });
    const result = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(result.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a refusal as a RESULT, not a JSON-RPC error", async () => {
    // The single most consequential mapping in this file. As an error, the
    // model gets an exception it cannot act on. As a result, it reads the code
    // and the corrective next call and fixes itself.
    const { body } = await rpc("tools/call", {
      name: "get_person",
      arguments: { person_id: "p_00000000-0000-4000-8000-000000000000" },
    });
    expect(body.error).toBeUndefined();

    const result = body.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe("not_found");
  });

  it("preserves the corrective next call, which is why ToolError carries one", async () => {
    const { body } = await rpc("tools/call", {
      name: "get_roster_entry",
      arguments: { roster_entry_id: "re_00000000-0000-4000-8000-000000000000" },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(payload.error.next).toContain("list_roster_sources");
  });

  it("preserves structured details, so duplicate candidates survive the trip", async () => {
    await rpc("tools/call", {
      name: "create_person",
      arguments: { full_name: "Ada Lovelace", organization: "Kinsta" },
    });
    const { body } = await rpc("tools/call", {
      name: "create_person",
      arguments: { full_name: "Ada Lovelace", organization: "Kinsta" },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(payload.error.code).toBe("conflict");
    expect(Array.isArray(payload.error.details)).toBe(true);
    expect(payload.error.details[0].evidence).toContain("shared name");
  });

  it("maps an id of the wrong kind to invalid_id, not to a crash", async () => {
    const { body } = await rpc("tools/call", {
      name: "log_encounter",
      arguments: { person_id: "re_1", occurred_on: "2026-08-20", summary: "x" },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    expect(payload.error.code).toBe("invalid_id");
  });

  it("reports an unknown tool without reaching the registry", async () => {
    const { body } = await rpc("tools/call", { name: "drop_everything", arguments: {} });
    expect(JSON.stringify(body)).toMatch(/unknown|not found/i);
  });

  it("NEVER leaks an internal exception message", async () => {
    // A raw exception can carry a SQL fragment with a person's name in it,
    // which would put PRM content into a transcript and a dashboard at once.
    const { body } = await rpc("tools/call", {
      name: "search_people",
      arguments: { query: "Ada", limit: 99999 },
    });
    const payload = JSON.parse((body.result as { content: { text: string }[] }).content[0]!.text);
    // A real refusal, with a real code - not a stack trace.
    expect(payload.error.code).toBe("limit_exceeded");
    expect(JSON.stringify(payload)).not.toMatch(/\bat .*\.ts:\d+/);
  });
});

describe("authorization", () => {
  it("REFUSES a valid token belonging to a different GitHub account", async () => {
    const { response } = await rpc("tools/list", {}, { githubUserId: "999999" });
    expect(response.status).toBe(403);
  });

  it("REFUSES a request whose grant carries no props", async () => {
    const { response } = await rpc("tools/list", {}, undefined);
    expect(response.status).toBe(403);
  });

  it("checks on tools/call as well as tools/list", async () => {
    const { response } = await rpc(
      "tools/call",
      { name: "create_person", arguments: { full_name: "Mallory" } },
      { githubUserId: "999999" }
    );
    expect(response.status).toBe(403);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe("statelessness", () => {
  it("answers two independent requests with no session between them", async () => {
    // No Durable Object, no session id. Each request builds a server, uses it
    // once, and discards it.
    const first = await rpc("tools/list", {});
    const second = await rpc("tools/list", {});
    expect((first.body.result as { tools: unknown[] }).tools).toHaveLength(28);
    expect((second.body.result as { tools: unknown[] }).tools).toHaveLength(28);
  });
});
