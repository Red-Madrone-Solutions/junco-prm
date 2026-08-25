// src/mcp/transport.ts - placeholder, replaced entirely by Task 7.
export function mcpHandler(
  _config: unknown,
  _requestId: string
): { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> } {
  return {
    async fetch(): Promise<Response> {
      return new Response("MCP transport arrives in Task 7", { status: 501 });
    },
  };
}
