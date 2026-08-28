import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools/index";
import { rpc } from "./helpers/rpc";

/**
 * Issues a bare GET to /mcp, the way an MCP client asks for a standalone SSE
 * stream. Separate from `rpc` because the point is the method, not a payload.
 */
async function get(props?: unknown) {
  const effectiveProps = arguments.length >= 1 ? props : { githubUserId: "583231" };
  const { mcpHandler } = await import("../src/mcp/transport");
  const { loadConfig } = await import("../src/config");
  const handler = mcpHandler(loadConfig(env), "r1");
  const request = new Request("https://example.test/mcp", {
    method: "GET",
    headers: { accept: "text/event-stream" },
  });
  return handler.fetch!(request, env as never, { props: effectiveProps } as ExecutionContext);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
});

describe("tools/list", () => {
  it("advertises all 30 tools from the registry", async () => {
    const { body } = await rpc("tools/list", {});
    const tools = (body.result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(30);
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
    expect(body.error).toBeUndefined();

    const result = body.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error.code).toBe("not_found");
    expect(payload.error.reason).toContain("drop_everything");
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

  it("reports a non-ToolError throw as `internal`, distinguishable by shape, with no leaked message", async () => {
    // `unexpectedErrorResult` is the eighth code, exercised nowhere else in the
    // suite. `search_people`'s own throw always lands as `limit_exceeded`, a
    // ToolError - so this forces a genuinely unexpected exception the same way
    // the review did: override a registry entry's `run`.
    const tool = TOOLS.search_people!;
    const original = tool.run;
    const leak = "SELECT full_name FROM people WHERE full_name = 'Ada Lovelace'";
    tool.run = async () => {
      throw new TypeError(leak);
    };
    try {
      const { body } = await rpc("tools/call", {
        name: "search_people",
        arguments: { query: "Ada" },
      });
      expect(body.error).toBeUndefined();

      const result = body.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.error.code).toBe("internal");
      expect(payload.error.next).toBeUndefined();
      expect(payload.error.details).toBeUndefined();
      expect(payload.error.request_id).toBe("r1");
      // The shape check, not just the name: nothing of the thrown message
      // survives into the payload the model sees.
      expect(JSON.stringify(payload)).not.toContain(leak);
      expect(JSON.stringify(payload)).not.toMatch(/Ada Lovelace/);
      expect(JSON.stringify(payload)).not.toMatch(/SELECT/);
    } finally {
      tool.run = original;
    }
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
    expect((first.body.result as { tools: unknown[] }).tools).toHaveLength(30);
    expect((second.body.result as { tools: unknown[] }).tools).toHaveLength(30);
  });
});


describe("GET /mcp", () => {
  /**
   * THE RECONNECT LOOP. This transport is stateless and holds no SSE stream,
   * but the SDK opens one for a GET carrying text/event-stream, and closing
   * the transport afterwards is documented by the SDK as "triggering client
   * reconnection". A 200 followed by an immediate close reads to a client as a
   * dropped stream, so it reconnects, forever.
   *
   * Measured before the guard: 196 requests in 45 seconds, all GET /mcp, all
   * 200, with no tool call and no user action. Each one spent a Workers
   * request and a KV read against free-tier ceilings of 100,000 a day.
   *
   * Deleting the method check in src/mcp/transport.ts turns this red.
   */
  it("refuses a GET with 405 rather than opening a stream it will not hold", async () => {
    const response = await get();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("names the refusal in a shape a client can read", async () => {
    const response = await get();
    const body = (await response.json()) as { error: string; request_id: string };
    expect(body.error).toBe("method_not_allowed");
    expect(body.request_id).toBe("r1");
  });

  /**
   * The guard sits after the ownership check on purpose. A stranger must not
   * learn which methods the endpoint accepts before being refused, and moving
   * the method check above assertOwner would turn this test red.
   */
  it("still refuses a stranger with 403 rather than 405", async () => {
    const response = await get({ githubUserId: "999999" });
    expect(response.status).toBe(403);
  });

  /** The guard must not have broken the path that actually carries traffic. */
  it("leaves POST working", async () => {
    const { body } = await rpc("tools/list", {});
    expect(Array.isArray((body.result as { tools: unknown[] }).tools)).toBe(true);
  });
});
