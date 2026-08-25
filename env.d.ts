namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

declare module "*.csv?raw" {
  const content: string;
  export default content;
}
