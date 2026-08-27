import { buildProvider } from "./auth/provider";
import { ConfigError, configErrorResponse, loadConfig } from "./config";
import { health } from "./health";
import { logRequest, newRequestId } from "./log";
import { mcpHandler } from "./mcp/transport";
import { isDailyQuotaError, quotaErrorResponse } from "./quota";
import { checkRateLimit, rateLimitedResponse } from "./ratelimit";

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

    // WRAPS THE PROVIDER, AND COVERS EVERY ROUTE INCLUDING /health AND /mcp.
    //
    // The previous version exempted both, and the reasoning for each was wrong.
    //
    // /health was exempt because the branch above returns before this line. The
    // spec names /health explicitly as one of the routes the limiter exists to
    // protect, and it costs a D1 query per hit.
    //
    // /mcp was exempt on the grounds that "rate-limiting the owner's own tool
    // calls would throttle the only legitimate traffic." That confused a path
    // with a caller. /mcp is not the authenticated path, it is the path that
    // REQUIRES authentication - and it is reachable by anyone. An anonymous
    // flood of token-shaped garbage still costs a Worker invocation and a KV
    // read for each token the provider tries to validate, which is exactly the
    // quota this limiter exists to defend.
    //
    // The real argument was for a HIGHER limit on /mcp, not for no limit.
    const bucket = url.pathname === "/mcp" ? "mcp" : "public";
    if (!(await checkRateLimit(env, request, bucket))) {
      return finish(rateLimitedResponse(requestId));
    }

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

    // THE QUOTA FLOOR. Every binding this Worker touches lives behind this
    // call, and Cloudflare's bindings throw when a daily allowance runs out.
    // The throw happens inside workers-oauth-provider, on the KV read that
    // validates every token, so without this catch the exception escapes the
    // Worker and Cloudflare answers with its own "Error 1101: Worker threw
    // exception, the site owner must fix the Worker script" page. That page is
    // wrong in every part a reader would act on, and it hides the one fact
    // that matters, which is that the allowance returns at midnight UTC.
    //
    // Only a daily allowance is translated. Anything else rethrows and keeps
    // reaching Cloudflare as a genuine 1101, because a real fault reported as
    // "try tomorrow" is worse than a real fault reported loudly.
    const provider = buildProvider(config, mcpHandler(config, requestId));
    try {
      return finish(await provider.fetch(tagged, env, ctx));
    } catch (e) {
      if (isDailyQuotaError(e)) return finish(quotaErrorResponse(e, requestId, new Date()));
      throw e;
    }
  },
};
