namespace Cloudflare {
  interface Env {
    // From plan 1
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];

    // Plan 2 bindings
    OAUTH_KV: KVNamespace;
    /**
     * Two limiters, verified available on the free plan by plan 1's Task 0.
     * `RATE_LIMITER` covers the OAuth and health routes; `MCP_RATE_LIMITER`
     * covers /mcp at a higher ceiling, because the owner's real tool traffic
     * lives there and an anonymous flood does too.
     */
    RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    MCP_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };

    // Plan 2 variables
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    COOKIE_ENCRYPTION_KEY: string;
    OWNER_GITHUB_USER_ID: string;
    OWNER_TIMEZONE: string;
  }
}

/**
 * Bare `Env` alias for `Cloudflare.Env`. `@cloudflare/workers-types` only ever
 * merges into `Cloudflare.Env` (see its `ExportedHandler<Env = Cloudflare.Env>`
 * default) - there is no ambient global `Env` interface anywhere in the
 * toolchain. This alias is what makes `loadConfig(env: Env)` and the runtime's
 * actual `env` argument (and `cloudflare:test`'s `env` export) the same type.
 */
type Env = Cloudflare.Env;

declare module "*.csv?raw" {
  const content: string;
  export default content;
}
