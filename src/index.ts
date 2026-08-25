import { health } from "./health";
import { logRequest, newRequestId } from "./log";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    const url = new URL(request.url);

    const response =
      url.pathname === "/health"
        ? await health(env, requestId)
        : new Response("not found", { status: 404 });

    // `path`, never `url`: an authorize URL's query string carries state and a
    // redirect_uri, and neither belongs in a log line.
    logRequest({
      requestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });

    return response;
  },
};
