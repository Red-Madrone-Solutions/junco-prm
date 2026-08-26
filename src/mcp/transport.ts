// THE WEB-STANDARD TRANSPORT, not `server/streamableHttp.js`. That one is the
// Node transport, built on IncomingMessage/ServerResponse, and it does not take
// a `Request` or return a `Response` - the previous version of this task named
// it anyway. Verified against @modelcontextprotocol/sdk 1.30.0 on 2026-08-24;
// see docs/MEASUREMENTS.md.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { assertOwner, NotOwnerError } from "../auth/authorize";
import type { Config } from "../config";
import type { FetchHandler } from "../auth/provider";
import { buildServer } from "./server";

/**
 * STATELESS Streamable HTTP. No Durable Object, no session id, no held-open GET.
 *
 * Cloudflare's McpAgent templates are deprecated for new servers, and stateless
 * avoids both an extra binding and a class of session bugs. A new server and a
 * new transport are constructed per request, used once, and discarded -
 * `sessionIdGenerator: undefined` is what puts the SDK in that mode.
 *
 * RETURNS `FetchHandler`, NOT `ExportedHandler`. The brief's interface names
 * `ExportedHandler`, but workers-types declares its `fetch` optional, and
 * `src/auth/provider.ts` documents exactly why that fails here: `buildProvider`
 * takes `apiHandler: FetchHandler`, whose `fetch` is required, and `src/index.ts`
 * passes this function's result straight to it. `ExportedHandler` also erases
 * `env` to `unknown` without an explicit type parameter, which is what broke
 * `buildServer(config, env, requestId)` below.
 */
export function mcpHandler(config: Config, requestId: string): FetchHandler {
  return {
    // `ctx` IS NOT OPTIONAL HERE. The previous version wrote `fetch(request, env)`
    // and read `env.props`, which is not where the library puts them - so every
    // authenticated request would have failed the ownership check and returned
    // 403. It failed closed, so it was a functionality blocker rather than a
    // hole, and it was invisible to the tests because they fabricated
    // `{...env, props}` and never went through the provider.
    async fetch(request, env, ctx): Promise<Response> {
      // AUTHORIZATION RUNS FIRST, ON EVERY REQUEST, before the body is parsed
      // and before any tool exists. workers-oauth-provider has validated the
      // bearer token it issued and exposed the grant's props as `ctx.props`;
      // its README is explicit that the handler "must still enforce application
      // permissions such as scope, ownership, and tenancy."
      try {
        assertOwner(config, (ctx as ExecutionContext & { props?: unknown }).props, requestId);
      } catch (e) {
        if (e instanceof NotOwnerError) {
          return new Response(
            JSON.stringify({ error: "forbidden", request_id: requestId }),
            { status: 403, headers: { "content-type": "application/json" } }
          );
        }
        throw e;
      }

      const server = buildServer(config, env, requestId);
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Stateless: no session id, no held-open GET, nothing to diverge
        // between a client's view and the server's.
        sessionIdGenerator: undefined,
        // Without this the transport answers POSTs as SSE. Claude handles
        // either, but every test in this plan calls `response.json()`, and a
        // JSON response is simpler to reason about for a server that never
        // streams anything.
        enableJsonResponse: true,
      });

      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        // Stateless mode builds both per request and discards them. Closing is
        // what releases them rather than leaving them to the isolate.
        await transport.close();
        await server.close();
      }
    },
  } satisfies FetchHandler;
}
