import { env } from "cloudflare:test";

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
 * "no props" test in tests/mcp.test.ts makes - would silently fall back to the
 * owner id and test nothing. `arguments.length` is what tells "omitted" and
 * "explicitly undefined" apart.
 */
export async function rpc(method: string, params: unknown, props?: unknown) {
  const effectiveProps = arguments.length >= 3 ? props : { githubUserId: "583231" };
  const { mcpHandler } = await import("../../src/mcp/transport");
  const { loadConfig } = await import("../../src/config");
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

/**
 * Issues a tools/call and returns the parsed payload plus whether the result
 * was an error. Every boundary test uses this rather than reaching into a
 * tool function, because the defect these tests exist for lives above the
 * handlers.
 */
export async function callTool(name: string, args: unknown) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, payload: JSON.parse(result.content[0]!.text) };
}
