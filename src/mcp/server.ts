import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config";
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { logToolCall } from "../log";
import { TOOLS } from "../tools/index";
import { toolErrorResult, unexpectedErrorResult } from "./errors";

/**
 * Builds a server from plan 1's registry. Per request, and discarded after.
 *
 * EVERYTHING ADVERTISED COMES FROM THE REGISTRY - name, description, input
 * schema, and all three annotations. Plan 1's Task 16 built it that way so this
 * file would not have to write 28 schemas next to no tests. If MCP needs
 * something the registry does not carry, the fix goes in plan 1's registry.
 */
export function buildServer(config: Config, env: Env, requestId: string): Server {
  const server = new Server(
    { name: "junco-prm", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Built once per request, from the deploy-time zone and a real clock. Every
  // date-shaped guarantee in plan 1 depends on this being right: due dates,
  // days_overdue, and the `today` envelope on every result.
  const ctx: ToolContext = {
    db: env.DB,
    timezone: config.ownerTimezone,
    clock: () => new Date(),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(TOOLS).map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Straight through. This is the whole reason for the low-level Server.
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.name,
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        // Every tool here touches only this instance's own D1 database.
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS[request.params.name];
    if (!tool) {
      // An unknown tool is a caller mistake, not a server fault, and it is
      // reported the same way every other refusal is - as a result the model
      // can read and act on.
      return {
        isError: true as const,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: {
                  code: "not_found",
                  reason: `unknown tool: ${request.params.name}`,
                  next: "call tools/list to see what this server offers",
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const startedAt = Date.now();
    try {
      const result = await tool.run(ctx, (request.params.arguments ?? {}) as never);
      logToolCall({
        requestId,
        tool: tool.name,
        durationMs: Date.now() - startedAt,
        outcome: "ok",
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      if (e instanceof ToolError) {
        logToolCall({
          requestId,
          tool: tool.name,
          durationMs: Date.now() - startedAt,
          outcome: "error",
          code: e.code,
        });
        return toolErrorResult(e);
      }
      // Not one of the seven codes, so it is a bug in this server. Logged with
      // a code the operator can grep for, and reported to the model without the
      // exception text - which can carry a SQL fragment with a person's name.
      logToolCall({
        requestId,
        tool: tool.name,
        durationMs: Date.now() - startedAt,
        outcome: "error",
        code: "internal",
      });
      return unexpectedErrorResult(requestId);
    }
  });

  return server;
}
