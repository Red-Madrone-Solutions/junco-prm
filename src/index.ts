import { buildProvider } from "./auth/provider";
import { ConfigError, configErrorResponse, loadConfig } from "./config";
import { health } from "./health";
import { logRequest, newRequestId } from "./log";
import { mcpHandler } from "./mcp/transport";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    const url = new URL(request.url);

    const finish = (response: Response) => {
      logRequest({
        requestId,
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    };

    // /health answers before configuration is checked, and it is the ONLY
    // route that does. An operator debugging an unconfigured instance needs
    // something to respond, and this route holds no data.
    if (url.pathname === "/health") return finish(await health(env, requestId));

    // FAIL CLOSED. Everything below - OAuth and tools alike - is unreachable
    // until every secret and variable is present and valid.
    let config;
    try {
      config = loadConfig(env);
    } catch (e) {
      if (e instanceof ConfigError) return finish(configErrorResponse(e, requestId));
      throw e;
    }

    // The request id travels to the OAuth handler on a header, so an auth
    // failure inside /callback can be correlated with this log line. A plain
    // query parameter would not survive GitHub's own redirect back to us.
    const tagged = new Request(request, {
      headers: new Headers([...request.headers, ["x-junco-request-id", requestId]]),
    });

    const provider = buildProvider(config, mcpHandler(config, requestId));
    return finish(await provider.fetch(tagged, env, ctx));
  },
};
