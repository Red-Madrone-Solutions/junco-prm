# Junco PRM Data Layer and Tool Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Junco PRM tool module and its SQLite schema as a pure library over a D1 handle, tested against local D1, with no HTTP transport and no authentication.

**Architecture:** Every PRM operation is a plain async function taking a `ToolContext` (a D1 handle, an owner time zone, and a clock) plus a typed input, returning a typed result. Nothing in this plan knows what MCP or OAuth is. Schema lives in numbered D1 migration files; FTS5 indexes are external-content tables kept in sync by SQLite triggers declared in those migrations, so no application code can forget to update them. A later plan wraps this module in a Worker and an MCP transport; this plan's deliverable is a library plus a test suite that proves it.

**Tech Stack:** TypeScript, Cloudflare Workers runtime (workerd), Cloudflare D1 (SQLite), Wrangler 4.x, Vitest with `@cloudflare/vitest-pool-workers`, Node 26 / npm 11.

**Spec:** `docs/superpowers/specs/2026-08-20-junco-prm-design.md`

## Scope

This is plan 1 of 3 for spec phase 1.

- **Plan 1 (this document)** - schema, migrations, FTS5, and the full tool module, tested against local D1.
- **Plan 2** - Worker entrypoint, MCP over stateless Streamable HTTP, `workers-oauth-provider`, GitHub as OAuth client, per-request owner authorization, `/health`, fail-closed behavior.
- **Plan 3** - `docs/DEPLOY.md` runbook, `docs/UPGRADE.md`, the deploy template, the CLI durable-data export, and the tested restore.

Plan 1 produces working, testable software on its own: a library whose every function is exercised against a real SQLite database.

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- **Every id is prefixed by kind and validated on input.** `p_` person, `re_` roster entry, `enc_` encounter, `fu_` follow-up, `rs_` roster source, `ir_` import run, `ps_` person source. Passing an id of the wrong kind is a rejected input, never a write.
- **The server never matches a person by name.** Not on create, not on import, not on promote. Names are not identities: the reference roster contains 11 duplicated names across 23 rows.
- **Every write accepts an optional `idempotency_key`.** The same key replayed with the same input returns the original result and writes nothing.
- **Every write returns the full affected record**, so a mistake is visible in the transcript immediately.
- **Destructive operations are two calls.** The first returns a preview and a `confirmation_token`; the second presents that token. There is no single-call destructive path.
- **Import identity is `(roster_source_id, external_row_key)`** under a unique constraint. `external_row_key` comes from the source, or is the SHA-256 of the normalized row when the source has none.
- **Import is resumable across calls,** capped at `IMPORT_BATCH_LIMIT = 200` rows per call. That cap is a server constant, never a caller's choice. Free-plan D1 allows 50 queries per Worker invocation and 100 bound parameters per query.
- **Timestamps are stored as UTC ISO-8601 instants.** Due dates are stored as `YYYY-MM-DD` local date strings and interpreted in `ToolContext.timezone`.
- **People are archived, never deleted, except through the explicit two-call hard-delete path.** Encounters, roster sources, and roster entries are hard-deletable.
- **Imported roster text is untrusted input.** It is stored and returned as data. No tool interprets it as an instruction, and no destructive action can be triggered by its content.
- **Logs never contain PRM content.** No name, note, organization, or contact detail is ever passed to `console.log`. Tool name, duration, outcome, and identifiers only.
- **Migrations are additive within a major version** and are applied with `--remote` against a deployment.

---

## File Structure

**Configuration and harness**

- `package.json` - dependencies and scripts.
- `tsconfig.json` - strict TypeScript.
- `wrangler.jsonc` - Worker name, D1 binding `DB`, migrations directory, observability.
- `vitest.config.ts` - workers pool, reads migrations, injects them into the test env.
- `tests/apply-migrations.ts` - setup file applying migrations before each test file.
- `env.d.ts` - types the test-only bindings.
- `src/index.ts` - stub Worker entrypoint. Plan 2 replaces it.

**Schema**

- `migrations/0001_durable_core.sql` - people, contacts, links, tags.
- `migrations/0002_staged_and_provenance.sql` - roster sources, import runs, roster entries, person sources, person-roster links.
- `migrations/0003_operational.sql` - idempotency keys, confirmation tokens.
- `migrations/0004_search.sql` - FTS5 external-content tables and sync triggers.

**Library**

- `src/errors.ts` - `ToolError` and its codes. One responsibility: how a tool refuses.
- `src/ids.ts` - id minting and prefix validation.
- `src/time.ts` - UTC instants and time-zone-aware local dates.
- `src/context.ts` - `ToolContext` and the row-to-record mappers shared across tools.
- `src/idempotency.ts` - the replay wrapper.
- `src/confirm.ts` - confirmation-token mint and redeem.
- `src/tools/people.ts` - create, update, archive, hard delete, get.
- `src/tools/attributes.ts` - contacts, links, tags.
- `src/tools/search.ts` - `search_people`.
- `src/tools/encounters.ts` - log, update, delete, list.
- `src/tools/followups.ts` - set, complete, cancel, list due.
- `src/tools/import.ts` - the resumable roster import protocol.
- `src/tools/promote.ts` - two-phase promotion and provenance copying.
- `src/tools/roster_admin.ts` - list sources, purge a source.
- `src/tools/index.ts` - the registry every later plan consumes.

Files that change together live together: each tool file owns its own SQL, its own input types, and its own record mapping. There is no shared repository layer, because a generic repository over eight tables would be a bigger thing to hold in context than the eight small files it replaced.

---

### Task 1: Project scaffold and a test harness that proves migrations run

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `env.d.ts`, `src/index.ts`
- Create: `migrations/0001_durable_core.sql`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an `Env` type with a `DB: D1Database` binding; a working `npm test` that applies every file in `migrations/` to a fresh in-memory D1 before each test file.

Why this is one task rather than four: the scaffold is worthless until something proves it works, and the first migration is the cheapest proof. A reviewer either accepts "migrations apply and the tables exist" or rejects it.

- [ ] **Step 1: Initialize the package and install dependencies**

```bash
npm init -y
npm pkg set name="junco-prm" private=true type="module"
npm pkg set scripts.test="vitest run" scripts.typecheck="tsc --noEmit"
npm install --save-dev wrangler@4 typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "env.d.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Write `wrangler.jsonc`**

`database_id` is a placeholder here only because no remote database exists yet. Plan 3's runbook writes the real id back into this file. Local D1 and the test harness ignore it.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "junco-prm",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "junco-prm",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
}
```

- [ ] **Step 4: Write the stub Worker entrypoint `src/index.ts`**

Plan 2 replaces this entirely. It exists so Wrangler has a `main` to resolve.

```ts
export default {
  async fetch(): Promise<Response> {
    return new Response("junco-prm: transport not implemented until plan 2", { status: 501 });
  },
};
```

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const migrations = await readD1Migrations("./migrations");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./tests/apply-migrations.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      },
    },
  },
});
```

- [ ] **Step 6: Write `tests/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 7: Write `env.d.ts`**

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

- [ ] **Step 8: Write the failing test `tests/schema.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("durable core schema", () => {
  it("creates the durable tables", async () => {
    const names = await tableNames();
    expect(names).toEqual(
      expect.arrayContaining(["people", "person_contacts", "person_links", "tags", "person_tags"])
    );
  });

  it("rejects a person row with no id", async () => {
    await expect(
      env.DB.prepare("INSERT INTO people (full_name, created_at, updated_at) VALUES (?, ?, ?)")
        .bind("No Id", "2026-08-20T00:00:00Z", "2026-08-20T00:00:00Z")
        .run()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL. The migrations directory does not exist yet, so `readD1Migrations` throws or the tables are absent.

- [ ] **Step 10: Write `migrations/0001_durable_core.sql`**

```sql
CREATE TABLE people (
  id                TEXT PRIMARY KEY,
  full_name         TEXT NOT NULL,
  preferred_name    TEXT,
  job_title         TEXT,
  organization      TEXT,
  notes             TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_people_archived ON people(archived_at);
CREATE INDEX idx_people_organization ON people(organization);

CREATE TABLE person_contacts (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email', 'phone')),
  value        TEXT NOT NULL,
  label        TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (person_id, contact_type, value)
);

CREATE INDEX idx_person_contacts_person ON person_contacts(person_id);
CREATE INDEX idx_person_contacts_value ON person_contacts(value);

CREATE TABLE person_links (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  link_type  TEXT NOT NULL,
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, link_type, url)
);

CREATE INDEX idx_person_links_person ON person_links(person_id);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE person_tags (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, tag_id)
);
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, both cases.

- [ ] **Step 12: Verify foreign keys are actually enforced**

D1 enforces foreign keys by default, unlike bare SQLite. Confirm rather than assume, because every later cascade depends on it.

Add to `tests/schema.test.ts`:

```ts
it("enforces the person foreign key on contacts", async () => {
  await expect(
    env.DB.prepare(
      "INSERT INTO person_contacts (id, person_id, contact_type, value, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("pc_1", "p_missing", "email", "nobody@example.com", "2026-08-20T00:00:00Z")
      .run()
  ).rejects.toThrow();
});
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json tsconfig.json wrangler.jsonc vitest.config.ts env.d.ts src/index.ts migrations/0001_durable_core.sql tests/
git commit -m "feat: scaffold project and durable core schema"
```

---

### Task 2: Ids, errors, and time

**Files:**
- Create: `src/errors.ts`, `src/ids.ts`, `src/time.ts`
- Test: `tests/ids.test.ts`, `tests/time.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class ToolError extends Error { code: ToolErrorCode; constructor(code: ToolErrorCode, message: string) }`
  - `type ToolErrorCode = "invalid_id" | "not_found" | "conflict" | "invalid_input" | "confirmation_required" | "confirmation_invalid"`
  - `type IdKind = "p" | "re" | "enc" | "fu" | "rs" | "ir" | "ps" | "pc" | "pl" | "tg"`
  - `function newId(kind: IdKind): string`
  - `function assertId(kind: IdKind, value: unknown): string` - returns the id, throws `ToolError("invalid_id", ...)` otherwise
  - `function nowIso(clock: () => Date): string`
  - `function localDate(timezone: string, instant: Date): string`
  - `function isLocalDate(value: unknown): value is string`

- [ ] **Step 1: Write the failing test `tests/ids.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors";
import { assertId, newId } from "../src/ids";

describe("newId", () => {
  it("prefixes by kind", () => {
    expect(newId("p")).toMatch(/^p_[0-9a-f-]{36}$/);
    expect(newId("enc")).toMatch(/^enc_[0-9a-f-]{36}$/);
  });

  it("does not collide", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("p")));
    expect(ids.size).toBe(500);
  });
});

describe("assertId", () => {
  it("returns an id of the right kind", () => {
    const id = newId("p");
    expect(assertId("p", id)).toBe(id);
  });

  it("rejects an id of the wrong kind", () => {
    const rosterEntry = newId("re");
    expect(() => assertId("p", rosterEntry)).toThrow(ToolError);
    try {
      assertId("p", rosterEntry);
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_id");
      expect((e as ToolError).message).toContain("expected a p_ id");
    }
  });

  it("rejects a bare uuid with no prefix", () => {
    expect(() => assertId("p", "3f1c2b9e-0000-4000-8000-000000000000")).toThrow(ToolError);
  });

  it("rejects non-strings", () => {
    expect(() => assertId("p", 42)).toThrow(ToolError);
    expect(() => assertId("p", null)).toThrow(ToolError);
    expect(() => assertId("p", undefined)).toThrow(ToolError);
  });

  it("rejects a prefix that is a prefix of another kind", () => {
    // "p" must not accept a "ps_" id, and "ps" must not accept a "p_" id.
    expect(() => assertId("p", newId("ps"))).toThrow(ToolError);
    expect(() => assertId("ps", newId("p"))).toThrow(ToolError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/ids.test.ts`
Expected: FAIL, cannot resolve `../src/ids`.

- [ ] **Step 3: Write `src/errors.ts`**

```ts
export type ToolErrorCode =
  | "invalid_id"
  | "not_found"
  | "conflict"
  | "invalid_input"
  | "confirmation_required"
  | "confirmation_invalid";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ToolError";
  }
}
```

- [ ] **Step 4: Write `src/ids.ts`**

```ts
import { ToolError } from "./errors";

export type IdKind = "p" | "re" | "enc" | "fu" | "rs" | "ir" | "ps" | "pc" | "pl" | "tg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newId(kind: IdKind): string {
  return `${kind}_${crypto.randomUUID()}`;
}

export function assertId(kind: IdKind, value: unknown): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_id", `expected a ${kind}_ id, got ${typeof value}`);
  }
  const marker = `${kind}_`;
  if (!value.startsWith(marker)) {
    throw new ToolError("invalid_id", `expected a ${kind}_ id, got "${value}"`);
  }
  if (!UUID.test(value.slice(marker.length))) {
    throw new ToolError("invalid_id", `expected a ${kind}_ id, got "${value}"`);
  }
  return value;
}
```

The `startsWith` check alone would let `ps_...` satisfy `assertId("p", ...)`, because `"ps_x".startsWith("p_")` is false but `"p_x".startsWith("p")` would be true if the marker omitted the underscore. Keeping the underscore in the marker and validating the UUID tail is what makes the prefix-of-another-kind test pass.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/ids.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 6: Write the failing test `tests/time.test.ts`**

The `en-CA` locale formats as `YYYY-MM-DD`, which is why it is used rather than string-slicing an ISO instant. Slicing gives the UTC date, which is the bug this module exists to prevent.

```ts
import { describe, expect, it } from "vitest";
import { isLocalDate, localDate, nowIso } from "../src/time";

describe("nowIso", () => {
  it("formats the clock as a UTC instant", () => {
    const fixed = new Date("2026-08-20T19:34:05.123Z");
    expect(nowIso(() => fixed)).toBe("2026-08-20T19:34:05.123Z");
  });
});

describe("localDate", () => {
  it("returns the owner's local date, not the UTC date", () => {
    // 02:30 UTC on the 21st is still the 20th in Los Angeles.
    const instant = new Date("2026-08-21T02:30:00Z");
    expect(localDate("America/Los_Angeles", instant)).toBe("2026-08-20");
    expect(localDate("UTC", instant)).toBe("2026-08-21");
  });

  it("handles a zone ahead of UTC", () => {
    const instant = new Date("2026-08-20T22:00:00Z");
    expect(localDate("Asia/Tokyo", instant)).toBe("2026-08-21");
  });
});

describe("isLocalDate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(isLocalDate("2026-08-20")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLocalDate("2026-8-20")).toBe(false);
    expect(isLocalDate("2026-08-20T00:00:00Z")).toBe(false);
    expect(isLocalDate("tomorrow")).toBe(false);
    expect(isLocalDate(20260820)).toBe(false);
  });
});
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `npx vitest run tests/time.test.ts`
Expected: FAIL, cannot resolve `../src/time`.

- [ ] **Step 8: Write `src/time.ts`**

```ts
export function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

export function localDate(timezone: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: unknown): value is string {
  return typeof value === "string" && LOCAL_DATE.test(value);
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/time.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/errors.ts src/ids.ts src/time.ts tests/ids.test.ts tests/time.test.ts
git commit -m "feat: add prefixed ids, tool errors, and timezone-aware dates"
```

---

### Task 3: Staged and provenance schema

**Files:**
- Create: `migrations/0002_staged_and_provenance.sql`
- Test: `tests/staged-schema.test.ts`

**Interfaces:**
- Consumes: `people` from Task 1.
- Produces: tables `roster_sources`, `import_runs`, `roster_entries`, `person_sources`, `person_roster_entries`, with the unique constraint `(roster_source_id, external_row_key)` that import idempotency depends on.

This is the task that fixes the spec's three provenance defects: `source_key` meaning two things, the drifting pointer pair, and durable data depending on disposable data.

- [ ] **Step 1: Write the failing test `tests/staged-schema.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T = "2026-08-20T00:00:00Z";

async function seedSource(): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind("rs_a", "wcus-2026", "WordCamp US 2026", "WCUS 2026", "https://example.test/a", T)
    .run();
  return "rs_a";
}

async function seedRun(sourceId: string): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO import_runs (id, roster_source_id, format, input_hash, status, started_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind("ir_a", sourceId, "csv", "hash-1", "open", T)
    .run();
  return "ir_a";
}

describe("staged schema", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM roster_entries").run();
    await env.DB.prepare("DELETE FROM import_runs").run();
    await env.DB.prepare("DELETE FROM roster_sources").run();
  });

  it("rejects a duplicate external row key within one source", async () => {
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    const insert = (id: string) =>
      env.DB.prepare(
        "INSERT INTO roster_entries (id, roster_source_id, external_row_key, full_name, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, sourceId, "row-7", "Ada Lovelace", "https://example.test/a", T, "{}", runId, T, T)
        .run();

    await insert("re_1");
    await expect(insert("re_2")).rejects.toThrow();
  });

  it("allows the same external row key under a different source", async () => {
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    await env.DB.prepare(
      "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind("rs_b", "wceu-2026", "WordCamp EU 2026", "WCEU 2026", "https://example.test/b", T)
      .run();
    await env.DB.prepare(
      "INSERT INTO import_runs (id, roster_source_id, format, input_hash, status, started_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind("ir_b", "rs_b", "csv", "hash-2", "open", T)
      .run();

    const insert = (id: string, source: string, run: string) =>
      env.DB.prepare(
        "INSERT INTO roster_entries (id, roster_source_id, external_row_key, full_name, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, source, "row-7", "Ada Lovelace", "https://example.test", T, "{}", run, T, T)
        .run();

    await insert("re_1", sourceId, runId);
    await expect(insert("re_2", "rs_b", "ir_b")).resolves.toBeTruthy();
  });

  it("links one person to more than one roster entry", async () => {
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    await env.DB.prepare(
      "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("p_1", "Ada Lovelace", T, T)
      .run();

    for (const [id, key] of [["re_1", "row-7"], ["re_2", "row-9"]]) {
      await env.DB.prepare(
        "INSERT INTO roster_entries (id, roster_source_id, external_row_key, full_name, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, sourceId, key, "Ada Lovelace", "https://example.test/a", T, "{}", runId, T, T)
        .run();
      await env.DB.prepare(
        "INSERT INTO person_roster_entries (person_id, roster_entry_id, linked_at) VALUES (?, ?, ?)"
      )
        .bind("p_1", id, T)
        .run();
    }

    const { results } = await env.DB.prepare(
      "SELECT roster_entry_id FROM person_roster_entries WHERE person_id = ? ORDER BY roster_entry_id"
    )
      .bind("p_1")
      .all<{ roster_entry_id: string }>();
    expect(results.map((r) => r.roster_entry_id)).toEqual(["re_1", "re_2"]);
  });

  it("keeps person provenance after the staged rows are purged", async () => {
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    await env.DB.prepare(
      "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("p_1", "Ada Lovelace", T, T)
      .run();
    await env.DB.prepare(
      "INSERT INTO roster_entries (id, roster_source_id, external_row_key, full_name, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("re_1", sourceId, "row-7", "Ada Lovelace", "https://example.test/a", T, "{}", runId, T, T)
      .run();
    await env.DB.prepare(
      "INSERT INTO person_sources (id, person_id, source_key, external_row_key, source_url, source_captured_at, raw_record_hash, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("ps_1", "p_1", "wcus-2026", "row-7", "https://example.test/a", T, "sha256:abc", T)
      .run();

    await env.DB.prepare("DELETE FROM roster_sources WHERE id = ?").bind(sourceId).run();

    const staged = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(staged?.n).toBe(0);

    const provenance = await env.DB.prepare(
      "SELECT source_key FROM person_sources WHERE person_id = ?"
    )
      .bind("p_1")
      .first<{ source_key: string }>();
    expect(provenance?.source_key).toBe("wcus-2026");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/staged-schema.test.ts`
Expected: FAIL, no such table `roster_sources`.

- [ ] **Step 3: Write `migrations/0002_staged_and_provenance.sql`**

```sql
CREATE TABLE roster_sources (
  id         TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  event      TEXT,
  url        TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE import_runs (
  id               TEXT PRIMARY KEY,
  roster_source_id TEXT NOT NULL REFERENCES roster_sources(id) ON DELETE CASCADE,
  format           TEXT NOT NULL CHECK (format IN ('csv', 'json', 'text')),
  input_hash       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open', 'committed', 'abandoned')),
  full_coverage    INTEGER NOT NULL DEFAULT 0,
  inserted_count   INTEGER NOT NULL DEFAULT 0,
  updated_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0,
  retired_count    INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  finished_at      TEXT
);

CREATE INDEX idx_import_runs_source ON import_runs(roster_source_id);

CREATE TABLE roster_entries (
  id                 TEXT PRIMARY KEY,
  roster_source_id   TEXT NOT NULL REFERENCES roster_sources(id) ON DELETE CASCADE,
  external_row_key   TEXT NOT NULL,
  full_name          TEXT NOT NULL,
  preferred_name     TEXT,
  job_title          TEXT,
  organization       TEXT,
  email              TEXT,
  role               TEXT,
  source_url         TEXT NOT NULL,
  source_captured_at TEXT NOT NULL,
  raw_record         TEXT NOT NULL,
  last_seen_run_id   TEXT NOT NULL REFERENCES import_runs(id),
  retired_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (roster_source_id, external_row_key)
);

CREATE INDEX idx_roster_entries_source ON roster_entries(roster_source_id);
CREATE INDEX idx_roster_entries_retired ON roster_entries(retired_at);

CREATE TABLE person_sources (
  id                 TEXT PRIMARY KEY,
  person_id          TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_key         TEXT NOT NULL,
  external_row_key   TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  source_captured_at TEXT NOT NULL,
  raw_record_hash    TEXT NOT NULL,
  promoted_at        TEXT NOT NULL,
  UNIQUE (person_id, source_key, external_row_key)
);

CREATE INDEX idx_person_sources_person ON person_sources(person_id);

CREATE TABLE person_roster_entries (
  person_id       TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  roster_entry_id TEXT NOT NULL REFERENCES roster_entries(id) ON DELETE CASCADE,
  linked_at       TEXT NOT NULL,
  PRIMARY KEY (person_id, roster_entry_id)
);
```

`person_sources` deliberately has no foreign key to `roster_sources` or `roster_entries`. That absence is the point: durable provenance must survive a purge of the staged data it was copied from.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/staged-schema.test.ts`
Expected: PASS, all four cases. The fourth is the one that matters most; it proves purging a source leaves the promoted person's provenance intact.

- [ ] **Step 5: Commit**

```bash
git add migrations/0002_staged_and_provenance.sql tests/staged-schema.test.ts
git commit -m "feat: add staged roster and durable provenance schema"
```

---

### Task 4: Idempotency and confirmation tokens

**Files:**
- Create: `migrations/0003_operational.sql`, `src/context.ts`, `src/idempotency.ts`, `src/confirm.ts`
- Test: `tests/idempotency.test.ts`, `tests/confirm.test.ts`

**Interfaces:**
- Consumes: `ToolError`, `newId`, `nowIso` from Task 2.
- Produces:
  - `interface ToolContext { db: D1Database; timezone: string; clock: () => Date }`
  - `function withIdempotency<T>(ctx: ToolContext, tool: string, key: string | undefined, input: unknown, run: () => Promise<T>): Promise<T>`
  - `function hashJson(value: unknown): Promise<string>` - stable SHA-256 over canonical JSON
  - `function mintConfirmation(ctx: ToolContext, action: string, targetId: string, preview: unknown): Promise<string>`
  - `function redeemConfirmation(ctx: ToolContext, action: string, targetId: string, token: unknown): Promise<void>`

These are cross-cutting and every write task after this one depends on them, which is why they come before any tool.

- [ ] **Step 1: Write `migrations/0003_operational.sql`**

```sql
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  tool          TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE confirmations (
  token      TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  preview    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE INDEX idx_confirmations_expiry ON confirmations(expires_at);
```

- [ ] **Step 2: Write `src/context.ts`**

```ts
export interface ToolContext {
  db: D1Database;
  timezone: string;
  clock: () => Date;
}
```

- [ ] **Step 3: Write the failing test `tests/idempotency.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { hashJson, withIdempotency } from "../src/idempotency";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("hashJson", () => {
  it("is stable across key order", async () => {
    expect(await hashJson({ a: 1, b: 2 })).toBe(await hashJson({ b: 2, a: 1 }));
  });

  it("differs on different values", async () => {
    expect(await hashJson({ a: 1 })).not.toBe(await hashJson({ a: 2 }));
  });
});

describe("withIdempotency", () => {
  it("runs the operation when no key is given", async () => {
    const run = vi.fn().mockResolvedValue({ ok: 1 });
    const first = await withIdempotency(ctx, "log_encounter", undefined, { x: 1 }, run);
    const second = await withIdempotency(ctx, "log_encounter", undefined, { x: 1 }, run);
    expect(first).toEqual({ ok: 1 });
    expect(second).toEqual({ ok: 1 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("replays the stored result instead of running twice", async () => {
    const run = vi.fn().mockResolvedValue({ id: "enc_1" });
    const first = await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    const second = await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects the same key with a different input", async () => {
    const run = vi.fn().mockResolvedValue({ id: "enc_1" });
    await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    await expect(
      withIdempotency(ctx, "log_encounter", "k1", { x: 2 }, run)
    ).rejects.toThrow(ToolError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("scopes keys by tool", async () => {
    const run = vi.fn().mockResolvedValue({ id: "a" });
    await withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    await withIdempotency(ctx, "set_followup", "k1", { x: 1 }, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not store a result when the operation throws", async () => {
    const run = vi.fn().mockRejectedValue(new ToolError("not_found", "nope"));
    await expect(withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run)).rejects.toThrow();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `npx vitest run tests/idempotency.test.ts`
Expected: FAIL, cannot resolve `../src/idempotency`.

- [ ] **Step 5: Write `src/idempotency.ts`**

```ts
import type { ToolContext } from "./context";
import { ToolError } from "./errors";
import { nowIso } from "./time";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export async function hashJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function withIdempotency<T>(
  ctx: ToolContext,
  tool: string,
  key: string | undefined,
  input: unknown,
  run: () => Promise<T>
): Promise<T> {
  if (!key) return run();

  const scoped = `${tool}:${key}`;
  const requestHash = await hashJson(input);

  const existing = await ctx.db
    .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?")
    .bind(scoped)
    .first<{ request_hash: string; response_json: string }>();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ToolError(
        "conflict",
        `idempotency_key "${key}" was already used by ${tool} with different arguments`
      );
    }
    return JSON.parse(existing.response_json) as T;
  }

  const result = await run();

  await ctx.db
    .prepare(
      "INSERT INTO idempotency_keys (key, tool, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(scoped, tool, requestHash, JSON.stringify(result), nowIso(ctx.clock))
    .run();

  return result;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/idempotency.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 7: Write the failing test `tests/confirm.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { mintConfirmation, redeemConfirmation } from "../src/confirm";

let now = new Date("2026-08-20T12:00:00Z");
const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => now,
};

beforeEach(async () => {
  now = new Date("2026-08-20T12:00:00Z");
  await env.DB.prepare("DELETE FROM confirmations").run();
});

describe("confirmation tokens", () => {
  it("redeems a matching token exactly once", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", { full_name: "Ada" });
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", token)).resolves.toBeUndefined();
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", token)).rejects.toThrow(ToolError);
  });

  it("rejects a token minted for a different target", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    await expect(redeemConfirmation(ctx, "delete_person", "p_2", token)).rejects.toThrow(ToolError);
  });

  it("rejects a token minted for a different action", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    await expect(redeemConfirmation(ctx, "purge_roster_source", "p_1", token)).rejects.toThrow(ToolError);
  });

  it("rejects an expired token", async () => {
    const token = await mintConfirmation(ctx, "delete_person", "p_1", {});
    now = new Date("2026-08-20T12:31:00Z");
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", token)).rejects.toThrow(ToolError);
  });

  it("rejects a missing or malformed token", async () => {
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", undefined)).rejects.toThrow(ToolError);
    await expect(redeemConfirmation(ctx, "delete_person", "p_1", "nonsense")).rejects.toThrow(ToolError);
  });
});
```

- [ ] **Step 8: Run it to make sure it fails**

Run: `npx vitest run tests/confirm.test.ts`
Expected: FAIL, cannot resolve `../src/confirm`.

- [ ] **Step 9: Write `src/confirm.ts`**

```ts
import type { ToolContext } from "./context";
import { ToolError } from "./errors";
import { nowIso } from "./time";

const TTL_MS = 30 * 60 * 1000;

export async function mintConfirmation(
  ctx: ToolContext,
  action: string,
  targetId: string,
  preview: unknown
): Promise<string> {
  const token = `cnf_${crypto.randomUUID()}`;
  const issued = ctx.clock();
  await ctx.db
    .prepare(
      "INSERT INTO confirmations (token, action, target_id, preview, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(
      token,
      action,
      targetId,
      JSON.stringify(preview),
      issued.toISOString(),
      new Date(issued.getTime() + TTL_MS).toISOString()
    )
    .run();
  return token;
}

export async function redeemConfirmation(
  ctx: ToolContext,
  action: string,
  targetId: string,
  token: unknown
): Promise<void> {
  if (typeof token !== "string" || !token.startsWith("cnf_")) {
    throw new ToolError(
      "confirmation_required",
      `${action} needs a confirmation_token from a preview call`
    );
  }

  const row = await ctx.db
    .prepare("SELECT action, target_id, expires_at, redeemed_at FROM confirmations WHERE token = ?")
    .bind(token)
    .first<{ action: string; target_id: string; expires_at: string; redeemed_at: string | null }>();

  if (!row) throw new ToolError("confirmation_invalid", "unknown confirmation_token");
  if (row.redeemed_at) throw new ToolError("confirmation_invalid", "confirmation_token already used");
  if (row.action !== action || row.target_id !== targetId) {
    throw new ToolError("confirmation_invalid", "confirmation_token does not match this operation");
  }
  if (new Date(row.expires_at).getTime() <= ctx.clock().getTime()) {
    throw new ToolError("confirmation_invalid", "confirmation_token expired");
  }

  await ctx.db
    .prepare("UPDATE confirmations SET redeemed_at = ? WHERE token = ? AND redeemed_at IS NULL")
    .bind(nowIso(ctx.clock), token)
    .run();
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run tests/confirm.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 11: Commit**

```bash
git add migrations/0003_operational.sql src/context.ts src/idempotency.ts src/confirm.ts tests/idempotency.test.ts tests/confirm.test.ts
git commit -m "feat: add idempotency replay and confirmation tokens"
```

---

### Task 5: FTS5 search indexes and their triggers

**Files:**
- Create: `migrations/0004_search.sql`
- Test: `tests/search-index.test.ts`

**Interfaces:**
- Consumes: `people` from Task 1, `encounters` is not yet created, so this task creates only the people index and Task 10 adds the encounters index alongside the encounters table.
- Produces: `people_fts`, an external-content FTS5 table over `people`, kept in sync by three triggers.

**Known risk this task exists to retire:** D1 migration files are split into statements by Wrangler before execution. A `CREATE TRIGGER ... BEGIN ... END;` body contains internal semicolons, and a naive splitter would cut it in half. The test below fails loudly if that happens, which is why the trigger sync is tested rather than assumed. If the migration cannot be applied as one file, the fallback is to move the triggers into their own migration file and, failing that, to create them from application code at startup. Do not proceed past this task with untested triggers.

- [ ] **Step 1: Write the failing test `tests/search-index.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T = "2026-08-20T00:00:00Z";

async function insertPerson(id: string, name: string, org: string | null, notes: string | null) {
  await env.DB.prepare(
    "INSERT INTO people (id, full_name, organization, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, name, org, notes, T, T)
    .run();
}

async function search(query: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id AS id
     FROM people_fts f
     JOIN people p ON p.rowid = f.rowid
     WHERE people_fts MATCH ?
     ORDER BY bm25(people_fts)`
  )
    .bind(query)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

describe("people_fts", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM people").run();
  });

  it("indexes a person on insert", async () => {
    await insertPerson("p_1", "Ada Lovelace", "Analytical Engines", null);
    expect(await search("Lovelace")).toEqual(["p_1"]);
    expect(await search("Analytical")).toEqual(["p_1"]);
  });

  it("reindexes on update", async () => {
    await insertPerson("p_1", "Ada Lovelace", "Analytical Engines", null);
    await env.DB.prepare("UPDATE people SET organization = ? WHERE id = ?")
      .bind("Difference Engines", "p_1")
      .run();
    expect(await search("Analytical")).toEqual([]);
    expect(await search("Difference")).toEqual(["p_1"]);
  });

  it("removes from the index on delete", async () => {
    await insertPerson("p_1", "Ada Lovelace", null, null);
    await env.DB.prepare("DELETE FROM people WHERE id = ?").bind("p_1").run();
    expect(await search("Lovelace")).toEqual([]);
  });

  it("searches note text", async () => {
    await insertPerson("p_1", "Grace Hopper", null, "met at the hallway track, owes me a compiler");
    expect(await search("compiler")).toEqual(["p_1"]);
  });

  it("ranks by bm25 with the better match first", async () => {
    await insertPerson("p_1", "Ada Lovelace", "Kinsta", null);
    await insertPerson("p_2", "Someone Else", "Kinsta Kinsta Kinsta", null);
    const ranked = await search("Kinsta");
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toBe("p_2");
  });

  it("treats imported text as data, not as syntax", async () => {
    // A roster row whose job title contains FTS operators must not break the query.
    await insertPerson("p_1", "Odd Row", "NOT AND OR *", null);
    await expect(search(`"NOT AND OR"`)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/search-index.test.ts`
Expected: FAIL, no such table `people_fts`.

- [ ] **Step 3: Write `migrations/0004_search.sql`**

```sql
CREATE VIRTUAL TABLE people_fts USING fts5(
  full_name,
  preferred_name,
  organization,
  job_title,
  notes,
  content='people',
  content_rowid='rowid'
);

CREATE TRIGGER people_fts_ai AFTER INSERT ON people BEGIN
  INSERT INTO people_fts (rowid, full_name, preferred_name, organization, job_title, notes)
  VALUES (new.rowid, new.full_name, new.preferred_name, new.organization, new.job_title, new.notes);
END;

CREATE TRIGGER people_fts_ad AFTER DELETE ON people BEGIN
  INSERT INTO people_fts (people_fts, rowid, full_name, preferred_name, organization, job_title, notes)
  VALUES ('delete', old.rowid, old.full_name, old.preferred_name, old.organization, old.job_title, old.notes);
END;

CREATE TRIGGER people_fts_au AFTER UPDATE ON people BEGIN
  INSERT INTO people_fts (people_fts, rowid, full_name, preferred_name, organization, job_title, notes)
  VALUES ('delete', old.rowid, old.full_name, old.preferred_name, old.organization, old.job_title, old.notes);
  INSERT INTO people_fts (rowid, full_name, preferred_name, organization, job_title, notes)
  VALUES (new.rowid, new.full_name, new.preferred_name, new.organization, new.job_title, new.notes);
END;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/search-index.test.ts`
Expected: PASS, all six cases.

If the migration fails to apply because of trigger-body statement splitting, stop and apply the fallback named at the top of this task before continuing. A silently half-created trigger set produces a search index that is correct on insert and wrong forever after.

- [ ] **Step 5: Commit**

```bash
git add migrations/0004_search.sql tests/search-index.test.ts
git commit -m "feat: add FTS5 people index with trigger-maintained sync"
```

---

### Task 6: Person records - create, update, get

**Files:**
- Create: `src/tools/people.ts`
- Test: `tests/people.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `ToolError`, `newId`, `assertId`, `nowIso`, `withIdempotency`.
- Produces:
  - `interface Person { id: string; record_kind: "person"; full_name: string; preferred_name: string | null; job_title: string | null; organization: string | null; notes: string | null; archived_at: string | null; created_at: string; updated_at: string }`
  - `interface PersonDetail extends Person { contacts: Contact[]; links: Link[]; tags: string[]; sources: Source[]; open_followups: Followup[]; recent_encounters: Encounter[]; encounter_count: number }`
  - `function createPerson(ctx, input): Promise<Person>`
  - `function updatePerson(ctx, input): Promise<Person>`
  - `function getPerson(ctx, input): Promise<PersonDetail>`

Task 7 fills `contacts`, `links`, `tags`; Task 10 fills `recent_encounters` and `encounter_count`; Task 11 fills `open_followups`; Task 13 fills `sources`. Until then those fields return empty arrays and zero, and the tests below assert exactly that so the shape is pinned from the start.

- [ ] **Step 1: Write the failing test `tests/people.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import { createPerson, getPerson, updatePerson } from "../src/tools/people";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("createPerson", () => {
  it("returns the full record with a prefixed id", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    expect(person.id).toMatch(/^p_/);
    expect(person.record_kind).toBe("person");
    expect(person.full_name).toBe("Ada Lovelace");
    expect(person.organization).toBe("Kinsta");
    expect(person.archived_at).toBeNull();
    expect(person.created_at).toBe("2026-08-20T12:00:00.000Z");
  });

  it("requires a non-empty full_name", async () => {
    await expect(createPerson(ctx, { full_name: "  " })).rejects.toThrow(ToolError);
    await expect(createPerson(ctx, {} as never)).rejects.toThrow(ToolError);
  });

  it("creates a second person with the same name without complaint", async () => {
    const a = await createPerson(ctx, { full_name: "Chris Smith" });
    const b = await createPerson(ctx, { full_name: "Chris Smith" });
    expect(a.id).not.toBe(b.id);
  });

  it("replays under the same idempotency_key", async () => {
    const a = await createPerson(ctx, { full_name: "Ada Lovelace", idempotency_key: "k1" });
    const b = await createPerson(ctx, { full_name: "Ada Lovelace", idempotency_key: "k1" });
    expect(b.id).toBe(a.id);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("updatePerson", () => {
  it("updates only the fields provided", async () => {
    const created = await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    const updated = await updatePerson(ctx, { person_id: created.id, job_title: "Engineer" });
    expect(updated.job_title).toBe("Engineer");
    expect(updated.organization).toBe("Kinsta");
    expect(updated.full_name).toBe("Ada Lovelace");
  });

  it("clears a field when explicitly set to null", async () => {
    const created = await createPerson(ctx, { full_name: "Ada", organization: "Kinsta" });
    const updated = await updatePerson(ctx, { person_id: created.id, organization: null });
    expect(updated.organization).toBeNull();
  });

  it("rejects a roster entry id", async () => {
    await expect(
      updatePerson(ctx, { person_id: newId("re"), job_title: "Engineer" })
    ).rejects.toThrow(ToolError);
    try {
      await updatePerson(ctx, { person_id: newId("re"), job_title: "x" });
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_id");
    }
  });

  it("rejects an unknown person", async () => {
    await expect(
      updatePerson(ctx, { person_id: newId("p"), job_title: "Engineer" })
    ).rejects.toThrow(ToolError);
  });
});

describe("getPerson", () => {
  it("returns the record with empty collections until later tasks fill them", async () => {
    const created = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const detail = await getPerson(ctx, { person_id: created.id });
    expect(detail.id).toBe(created.id);
    expect(detail.contacts).toEqual([]);
    expect(detail.links).toEqual([]);
    expect(detail.tags).toEqual([]);
    expect(detail.sources).toEqual([]);
    expect(detail.open_followups).toEqual([]);
    expect(detail.recent_encounters).toEqual([]);
    expect(detail.encounter_count).toBe(0);
  });

  it("rejects an id of the wrong kind", async () => {
    await expect(getPerson(ctx, { person_id: newId("enc") })).rejects.toThrow(ToolError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/people.test.ts`
Expected: FAIL, cannot resolve `../src/tools/people`.

- [ ] **Step 3: Write `src/tools/people.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";

export interface Person {
  id: string;
  record_kind: "person";
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  organization: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonDetail extends Person {
  contacts: unknown[];
  links: unknown[];
  tags: string[];
  sources: unknown[];
  open_followups: unknown[];
  recent_encounters: unknown[];
  encounter_count: number;
}

interface PersonRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  organization: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toPerson(row: PersonRow): Person {
  return { record_kind: "person", ...row };
}

const WRITABLE = ["full_name", "preferred_name", "job_title", "organization", "notes"] as const;
type Writable = (typeof WRITABLE)[number];

export interface CreatePersonInput {
  full_name: string;
  preferred_name?: string | null;
  job_title?: string | null;
  organization?: string | null;
  notes?: string | null;
  idempotency_key?: string;
}

function requireName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError("invalid_input", "full_name is required and must be a non-empty string");
  }
  return value.trim();
}

export async function createPerson(ctx: ToolContext, input: CreatePersonInput): Promise<Person> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "create_person", idempotency_key, rest, async () => {
    const full_name = requireName(input.full_name);
    const id = newId("p");
    const at = nowIso(ctx.clock);

    await ctx.db
      .prepare(
        `INSERT INTO people (id, full_name, preferred_name, job_title, organization, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        full_name,
        input.preferred_name ?? null,
        input.job_title ?? null,
        input.organization ?? null,
        input.notes ?? null,
        at,
        at
      )
      .run();

    return loadPerson(ctx, id);
  });
}

export interface UpdatePersonInput extends Partial<Record<Writable, string | null>> {
  person_id: string;
  idempotency_key?: string;
}

export async function updatePerson(ctx: ToolContext, input: UpdatePersonInput): Promise<Person> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "update_person", idempotency_key, rest, async () => {
    const id = assertId("p", input.person_id);

    const sets: string[] = [];
    const values: (string | null)[] = [];
    for (const field of WRITABLE) {
      if (!(field in input)) continue;
      const value = input[field];
      if (field === "full_name") {
        sets.push("full_name = ?");
        values.push(requireName(value));
      } else {
        sets.push(`${field} = ?`);
        values.push(value ?? null);
      }
    }

    if (sets.length === 0) {
      throw new ToolError("invalid_input", "update_person needs at least one field to change");
    }

    sets.push("updated_at = ?");
    values.push(nowIso(ctx.clock));

    const result = await ctx.db
      .prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();

    if (result.meta.changes === 0) {
      throw new ToolError("not_found", `no person with id ${id}`);
    }

    return loadPerson(ctx, id);
  });
}

export async function loadPerson(ctx: ToolContext, id: string): Promise<Person> {
  const row = await ctx.db
    .prepare(
      `SELECT id, full_name, preferred_name, job_title, organization, notes, archived_at, created_at, updated_at
       FROM people WHERE id = ?`
    )
    .bind(id)
    .first<PersonRow>();
  if (!row) throw new ToolError("not_found", `no person with id ${id}`);
  return toPerson(row);
}

export interface GetPersonInput {
  person_id: string;
  encounter_limit?: number;
  encounter_cursor?: string;
}

export async function getPerson(ctx: ToolContext, input: GetPersonInput): Promise<PersonDetail> {
  const id = assertId("p", input.person_id);
  const person = await loadPerson(ctx, id);
  return {
    ...person,
    contacts: [],
    links: [],
    tags: [],
    sources: [],
    open_followups: [],
    recent_encounters: [],
    encounter_count: 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/people.test.ts`
Expected: PASS, all ten cases.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/people.ts tests/people.test.ts
git commit -m "feat: add create, update, and get for people"
```

---

### Task 7: Contacts, links, and tags

**Files:**
- Create: `src/tools/attributes.ts`
- Modify: `src/tools/people.ts` - `getPerson` now loads real collections
- Test: `tests/attributes.test.ts`

**Interfaces:**
- Consumes: `loadPerson`, `assertId`, `withIdempotency`.
- Produces:
  - `interface Contact { id: string; contact_type: "email" | "phone"; value: string; label: string | null }`
  - `interface Link { id: string; link_type: string; url: string }`
  - `function addContact(ctx, input): Promise<PersonDetail>`
  - `function removeContact(ctx, input): Promise<PersonDetail>`
  - `function addLink(ctx, input): Promise<PersonDetail>`
  - `function removeLink(ctx, input): Promise<PersonDetail>`
  - `function setTags(ctx, input): Promise<PersonDetail>`
  - `function loadContacts(ctx, personId): Promise<Contact[]>`, `loadLinks`, `loadTags`

Every one of these returns the full `PersonDetail` rather than the row it touched, per the global constraint that a write shows the whole affected record.

- [ ] **Step 1: Write the failing test `tests/attributes.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import { addContact, addLink, removeContact, setTags } from "../src/tools/attributes";
import { createPerson, getPerson } from "../src/tools/people";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM tags").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("contacts", () => {
  it("adds an email and returns the whole person", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const detail = await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "ada@example.test",
    });
    expect(detail.id).toBe(person.id);
    expect(detail.contacts).toEqual([
      expect.objectContaining({ contact_type: "email", value: "ada@example.test" }),
    ]);
  });

  it("is idempotent on the same value without needing a key", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addContact(ctx, { person_id: person.id, contact_type: "email", value: "a@example.test" });
    const detail = await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "a@example.test",
    });
    expect(detail.contacts).toHaveLength(1);
  });

  it("rejects an unknown contact_type", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      addContact(ctx, { person_id: person.id, contact_type: "fax" as never, value: "x" })
    ).rejects.toThrow(ToolError);
  });

  it("removes a contact by its prefixed id", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const added = await addContact(ctx, {
      person_id: person.id,
      contact_type: "phone",
      value: "+1-555-0100",
    });
    const contactId = (added.contacts[0] as { id: string }).id;
    expect(contactId).toMatch(/^pc_/);
    const after = await removeContact(ctx, { person_id: person.id, contact_id: contactId });
    expect(after.contacts).toEqual([]);
  });

  it("rejects a person id where a contact id belongs", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      removeContact(ctx, { person_id: person.id, contact_id: newId("p") })
    ).rejects.toThrow(ToolError);
  });
});

describe("links", () => {
  it("stores websites and social profiles in one table typed by link_type", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addLink(ctx, { person_id: person.id, link_type: "website", url: "https://example.test" });
    const detail = await addLink(ctx, {
      person_id: person.id,
      link_type: "mastodon",
      url: "https://mas.to/@ada",
    });
    expect(detail.links).toHaveLength(2);
    expect(detail.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ link_type: "website" }),
        expect.objectContaining({ link_type: "mastodon" }),
      ])
    );
  });
});

describe("tags", () => {
  it("sets tags, creating them on first use", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const detail = await setTags(ctx, { person_id: person.id, tags: ["wcus", "follow-up"] });
    expect(detail.tags.sort()).toEqual(["follow-up", "wcus"]);
  });

  it("replaces the whole set rather than appending", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await setTags(ctx, { person_id: person.id, tags: ["wcus", "follow-up"] });
    const detail = await setTags(ctx, { person_id: person.id, tags: ["wcus"] });
    expect(detail.tags).toEqual(["wcus"]);
  });

  it("reuses an existing tag row across people", async () => {
    const a = await createPerson(ctx, { full_name: "Ada" });
    const b = await createPerson(ctx, { full_name: "Grace" });
    await setTags(ctx, { person_id: a.id, tags: ["wcus"] });
    await setTags(ctx, { person_id: b.id, tags: ["wcus"] });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("normalizes tag names to lowercase and trims them", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const detail = await setTags(ctx, { person_id: person.id, tags: ["  WCUS  ", "wcus"] });
    expect(detail.tags).toEqual(["wcus"]);
  });
});

describe("getPerson", () => {
  it("returns the collections the earlier task stubbed", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await addContact(ctx, { person_id: person.id, contact_type: "email", value: "a@example.test" });
    await setTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const detail = await getPerson(ctx, { person_id: person.id });
    expect(detail.contacts).toHaveLength(1);
    expect(detail.tags).toEqual(["wcus"]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/attributes.test.ts`
Expected: FAIL, cannot resolve `../src/tools/attributes`.

- [ ] **Step 3: Write `src/tools/attributes.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import { getPerson, loadPerson, type PersonDetail } from "./people";

export interface Contact {
  id: string;
  contact_type: "email" | "phone";
  value: string;
  label: string | null;
}

export interface Link {
  id: string;
  link_type: string;
  url: string;
}

export async function loadContacts(ctx: ToolContext, personId: string): Promise<Contact[]> {
  const { results } = await ctx.db
    .prepare(
      "SELECT id, contact_type, value, label FROM person_contacts WHERE person_id = ? ORDER BY created_at, id"
    )
    .bind(personId)
    .all<Contact>();
  return results;
}

export async function loadLinks(ctx: ToolContext, personId: string): Promise<Link[]> {
  const { results } = await ctx.db
    .prepare("SELECT id, link_type, url FROM person_links WHERE person_id = ? ORDER BY created_at, id")
    .bind(personId)
    .all<Link>();
  return results;
}

export async function loadTags(ctx: ToolContext, personId: string): Promise<string[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT t.name AS name FROM person_tags pt
       JOIN tags t ON t.id = pt.tag_id
       WHERE pt.person_id = ? ORDER BY t.name`
    )
    .bind(personId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export interface AddContactInput {
  person_id: string;
  contact_type: "email" | "phone";
  value: string;
  label?: string | null;
  idempotency_key?: string;
}

export async function addContact(ctx: ToolContext, input: AddContactInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "add_contact", idempotency_key, rest, async () => {
    const personId = assertId("p", input.person_id);
    if (input.contact_type !== "email" && input.contact_type !== "phone") {
      throw new ToolError("invalid_input", 'contact_type must be "email" or "phone"');
    }
    if (typeof input.value !== "string" || input.value.trim() === "") {
      throw new ToolError("invalid_input", "value is required");
    }
    await loadPerson(ctx, personId);

    await ctx.db
      .prepare(
        `INSERT INTO person_contacts (id, person_id, contact_type, value, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (person_id, contact_type, value) DO NOTHING`
      )
      .bind(newId("pc"), personId, input.contact_type, input.value.trim(), input.label ?? null, nowIso(ctx.clock))
      .run();

    return getPerson(ctx, { person_id: personId });
  });
}

export interface RemoveContactInput {
  person_id: string;
  contact_id: string;
  idempotency_key?: string;
}

export async function removeContact(ctx: ToolContext, input: RemoveContactInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "remove_contact", idempotency_key, rest, async () => {
    const personId = assertId("p", input.person_id);
    const contactId = assertId("pc", input.contact_id);
    const result = await ctx.db
      .prepare("DELETE FROM person_contacts WHERE id = ? AND person_id = ?")
      .bind(contactId, personId)
      .run();
    if (result.meta.changes === 0) {
      throw new ToolError("not_found", `no contact ${contactId} on person ${personId}`);
    }
    return getPerson(ctx, { person_id: personId });
  });
}

export interface AddLinkInput {
  person_id: string;
  link_type: string;
  url: string;
  idempotency_key?: string;
}

export async function addLink(ctx: ToolContext, input: AddLinkInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "add_link", idempotency_key, rest, async () => {
    const personId = assertId("p", input.person_id);
    if (typeof input.link_type !== "string" || input.link_type.trim() === "") {
      throw new ToolError("invalid_input", "link_type is required");
    }
    if (typeof input.url !== "string" || input.url.trim() === "") {
      throw new ToolError("invalid_input", "url is required");
    }
    await loadPerson(ctx, personId);

    await ctx.db
      .prepare(
        `INSERT INTO person_links (id, person_id, link_type, url, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (person_id, link_type, url) DO NOTHING`
      )
      .bind(newId("pl"), personId, input.link_type.trim(), input.url.trim(), nowIso(ctx.clock))
      .run();

    return getPerson(ctx, { person_id: personId });
  });
}

export interface RemoveLinkInput {
  person_id: string;
  link_id: string;
  idempotency_key?: string;
}

export async function removeLink(ctx: ToolContext, input: RemoveLinkInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "remove_link", idempotency_key, rest, async () => {
    const personId = assertId("p", input.person_id);
    const linkId = assertId("pl", input.link_id);
    const result = await ctx.db
      .prepare("DELETE FROM person_links WHERE id = ? AND person_id = ?")
      .bind(linkId, personId)
      .run();
    if (result.meta.changes === 0) {
      throw new ToolError("not_found", `no link ${linkId} on person ${personId}`);
    }
    return getPerson(ctx, { person_id: personId });
  });
}

export interface SetTagsInput {
  person_id: string;
  tags: string[];
  idempotency_key?: string;
}

export async function setTags(ctx: ToolContext, input: SetTagsInput): Promise<PersonDetail> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "set_tags", idempotency_key, rest, async () => {
    const personId = assertId("p", input.person_id);
    if (!Array.isArray(input.tags)) {
      throw new ToolError("invalid_input", "tags must be an array of strings");
    }
    await loadPerson(ctx, personId);

    const names = [
      ...new Set(
        input.tags.map((t) => {
          if (typeof t !== "string") throw new ToolError("invalid_input", "tags must be strings");
          return t.trim().toLowerCase();
        })
      ),
    ].filter((t) => t !== "");

    const at = nowIso(ctx.clock);
    const statements = [
      ctx.db.prepare("DELETE FROM person_tags WHERE person_id = ?").bind(personId),
      ...names.flatMap((name) => [
        ctx.db
          .prepare("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING")
          .bind(newId("tg"), name, at),
        ctx.db
          .prepare(
            "INSERT INTO person_tags (person_id, tag_id) SELECT ?, id FROM tags WHERE name = ?"
          )
          .bind(personId, name),
      ]),
    ];

    await ctx.db.batch(statements);
    return getPerson(ctx, { person_id: personId });
  });
}
```

- [ ] **Step 4: Modify `getPerson` in `src/tools/people.ts` to load the real collections**

Replace the body of `getPerson` with:

```ts
export async function getPerson(ctx: ToolContext, input: GetPersonInput): Promise<PersonDetail> {
  const id = assertId("p", input.person_id);
  const person = await loadPerson(ctx, id);
  const { loadContacts, loadLinks, loadTags } = await import("./attributes");
  const [contacts, links, tags] = await Promise.all([
    loadContacts(ctx, id),
    loadLinks(ctx, id),
    loadTags(ctx, id),
  ]);
  return {
    ...person,
    contacts,
    links,
    tags,
    sources: [],
    open_followups: [],
    recent_encounters: [],
    encounter_count: 0,
  };
}
```

The dynamic `import` breaks the cycle between `people.ts` and `attributes.ts`, which import each other. If the reviewer prefers, extract the three loaders into `src/tools/attributes_read.ts` and import statically from both. Either is acceptable; do not leave a static circular import.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/attributes.test.ts tests/people.test.ts`
Expected: PASS. The `getPerson` stub assertions in `tests/people.test.ts` still pass because a person with no attributes still has empty collections.

- [ ] **Step 6: Commit**

```bash
git add src/tools/attributes.ts src/tools/people.ts tests/attributes.test.ts
git commit -m "feat: add contacts, links, and tags"
```

---

### Task 8: Archiving and the two-call hard delete

**Files:**
- Create: `migrations/0005_encounters_followups.sql`
- Modify: `src/tools/people.ts`
- Test: `tests/people-lifecycle.test.ts`

**Interfaces:**
- Consumes: `mintConfirmation`, `redeemConfirmation` from Task 4.
- Produces:
  - `function archivePerson(ctx, input): Promise<Person>`
  - `function unarchivePerson(ctx, input): Promise<Person>`
  - `function deletePerson(ctx, input): Promise<DeletePersonResult>`
  - `type DeletePersonResult = { status: "confirmation_required"; confirmation_token: string; preview: DeletePreview } | { status: "deleted"; deleted: DeletePreview }`
  - `interface DeletePreview { person_id: string; full_name: string; encounter_count: number; followup_count: number; contact_count: number }`

`archived_at` has existed as a column since Task 1 with no tool able to set it. This task closes that. The hard delete exists because a PRM holding other people's contact details cannot answer a deletion request with "we only archive," and it is two calls because it is unreversible.

- [ ] **Step 1: Write the failing test `tests/people-lifecycle.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { archivePerson, createPerson, deletePerson, unarchivePerson } from "../src/tools/people";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM confirmations").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("archivePerson", () => {
  it("sets archived_at and is reversible", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const archived = await archivePerson(ctx, { person_id: person.id });
    expect(archived.archived_at).toBe("2026-08-20T12:00:00.000Z");
    const restored = await unarchivePerson(ctx, { person_id: person.id });
    expect(restored.archived_at).toBeNull();
  });

  it("archiving twice is not an error", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await archivePerson(ctx, { person_id: person.id });
    const again = await archivePerson(ctx, { person_id: person.id });
    expect(again.archived_at).not.toBeNull();
  });
});

describe("deletePerson", () => {
  it("returns a preview and a token instead of deleting on the first call", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const first = await deletePerson(ctx, { person_id: person.id });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    expect(first.confirmation_token).toMatch(/^cnf_/);
    expect(first.preview.full_name).toBe("Ada Lovelace");

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("deletes when the token is presented", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const first = await deletePerson(ctx, { person_id: person.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    const second = await deletePerson(ctx, {
      person_id: person.id,
      confirmation_token: first.confirmation_token,
    });
    expect(second.status).toBe("deleted");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("refuses a token issued for a different person", async () => {
    const a = await createPerson(ctx, { full_name: "Ada" });
    const b = await createPerson(ctx, { full_name: "Grace" });
    const first = await deletePerson(ctx, { person_id: a.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    await expect(
      deletePerson(ctx, { person_id: b.id, confirmation_token: first.confirmation_token })
    ).rejects.toThrow(ToolError);
  });

  it("cascades to contacts, links, and tags", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await env.DB.prepare(
      "INSERT INTO person_contacts (id, person_id, contact_type, value, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind("pc_x", person.id, "email", "a@example.test", "2026-08-20T00:00:00Z")
      .run();

    const first = await deletePerson(ctx, { person_id: person.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    await deletePerson(ctx, { person_id: person.id, confirmation_token: first.confirmation_token });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM person_contacts").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/people-lifecycle.test.ts`
Expected: FAIL, `archivePerson` is not exported.

- [ ] **Step 3: Write `migrations/0005_encounters_followups.sql`**

`deletePreview` below counts encounters and follow-ups, so their tables must exist before this task's own logic can be tested. The tools that write them arrive in Tasks 10 and 11; only the schema lands here.

```sql
CREATE TABLE encounters (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  occurred_on  TEXT NOT NULL,
  occurred_at  TEXT,
  location     TEXT,
  event        TEXT,
  summary      TEXT NOT NULL,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_encounters_person ON encounters(person_id, occurred_on DESC);
CREATE INDEX idx_encounters_event ON encounters(event);
CREATE INDEX idx_encounters_deleted ON encounters(deleted_at);

CREATE TABLE followups (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  due_on       TEXT NOT NULL,
  note         TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_followups_open ON followups(due_on) WHERE completed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX idx_followups_person ON followups(person_id);
```

`occurred_on` is a `YYYY-MM-DD` local date in the owner's zone; `occurred_at` is an optional UTC instant when the exact time is known. `due_on` is a local date, never an instant, per the global constraints.

- [ ] **Step 4: Append to `src/tools/people.ts`**

```ts
import { mintConfirmation, redeemConfirmation } from "../confirm";

export interface ArchivePersonInput {
  person_id: string;
  idempotency_key?: string;
}

async function setArchived(
  ctx: ToolContext,
  input: ArchivePersonInput,
  tool: string,
  value: string | null
): Promise<Person> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, tool, idempotency_key, rest, async () => {
    const id = assertId("p", input.person_id);
    const result = await ctx.db
      .prepare("UPDATE people SET archived_at = ?, updated_at = ? WHERE id = ?")
      .bind(value, nowIso(ctx.clock), id)
      .run();
    if (result.meta.changes === 0) throw new ToolError("not_found", `no person with id ${id}`);
    return loadPerson(ctx, id);
  });
}

export function archivePerson(ctx: ToolContext, input: ArchivePersonInput): Promise<Person> {
  return setArchived(ctx, input, "archive_person", nowIso(ctx.clock));
}

export function unarchivePerson(ctx: ToolContext, input: ArchivePersonInput): Promise<Person> {
  return setArchived(ctx, input, "unarchive_person", null);
}

export interface DeletePreview {
  person_id: string;
  full_name: string;
  encounter_count: number;
  followup_count: number;
  contact_count: number;
}

export type DeletePersonResult =
  | { status: "confirmation_required"; confirmation_token: string; preview: DeletePreview }
  | { status: "deleted"; deleted: DeletePreview };

export interface DeletePersonInput {
  person_id: string;
  confirmation_token?: string;
}

async function deletePreview(ctx: ToolContext, id: string): Promise<DeletePreview> {
  const person = await loadPerson(ctx, id);
  const counts = await ctx.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM person_contacts WHERE person_id = ?1) AS contacts,
         (SELECT COUNT(*) FROM encounters WHERE person_id = ?1 AND deleted_at IS NULL) AS encounters,
         (SELECT COUNT(*) FROM followups WHERE person_id = ?1) AS followups`
    )
    .bind(id)
    .first<{ contacts: number; encounters: number; followups: number }>();

  return {
    person_id: id,
    full_name: person.full_name,
    contact_count: counts?.contacts ?? 0,
    encounter_count: counts?.encounters ?? 0,
    followup_count: counts?.followups ?? 0,
  };
}

export async function deletePerson(
  ctx: ToolContext,
  input: DeletePersonInput
): Promise<DeletePersonResult> {
  const id = assertId("p", input.person_id);

  if (input.confirmation_token === undefined) {
    const preview = await deletePreview(ctx, id);
    const confirmation_token = await mintConfirmation(ctx, "delete_person", id, preview);
    return { status: "confirmation_required", confirmation_token, preview };
  }

  await redeemConfirmation(ctx, "delete_person", id, input.confirmation_token);
  const preview = await deletePreview(ctx, id);
  await ctx.db.prepare("DELETE FROM people WHERE id = ?").bind(id).run();
  return { status: "deleted", deleted: preview };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/people-lifecycle.test.ts`
Expected: PASS, all six cases. The cascade case is the one that proves the foreign keys from Task 1 are doing real work.

- [ ] **Step 6: Commit**

```bash
git add migrations/0005_encounters_followups.sql src/tools/people.ts tests/people-lifecycle.test.ts
git commit -m "feat: add archive and two-call hard delete for people"
```

---

### Task 9: `search_people`

**Files:**
- Create: `src/tools/search.ts`
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: `people_fts` from Task 5, `ToolError`.
- Produces:
  - `type SearchScope = "contacts" | "roster" | "all"`
  - `interface PersonHit { record_kind: "person"; id: string; full_name: string; organization: string | null; job_title: string | null; archived_at: string | null; last_encounter_on: string | null; tags: string[] }`
  - `interface RosterHit { record_kind: "roster_entry"; id: string; full_name: string; organization: string | null; job_title: string | null; source_key: string; promoted_person_id: string | null }`
  - `function searchPeople(ctx, input): Promise<{ results: (PersonHit | RosterHit)[]; scope: SearchScope; truncated: boolean }>`

`scope` is an explicit enum, never a boolean, and `record_kind` is mandatory on every hit. Both exist so an agent cannot pass a `re_` id into a tool expecting a `p_` id, which the spec names as the most likely real failure.

- [ ] **Step 1: Write the failing test `tests/search.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { setTags } from "../src/tools/attributes";
import { createPerson } from "../src/tools/people";
import { searchPeople } from "../src/tools/search";

const T = "2026-08-20T00:00:00Z";
const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date(T),
};

async function seedRoster() {
  await env.DB.prepare(
    "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind("rs_a", "wcus-2026", "WCUS 2026", "WCUS", "https://example.test", T)
    .run();
  await env.DB.prepare(
    "INSERT INTO import_runs (id, roster_source_id, format, input_hash, status, started_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind("ir_a", "rs_a", "csv", "h", "committed", T)
    .run();
  await env.DB.prepare(
    "INSERT INTO roster_entries (id, roster_source_id, external_row_key, full_name, organization, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind("re_1", "rs_a", "row-1", "Grace Hopper", "Navy", "https://example.test", T, "{}", "ir_a", T, T)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM tags").run();
});

describe("searchPeople", () => {
  it("defaults to durable contacts only", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    await seedRoster();

    const out = await searchPeople(ctx, { query: "Hopper" });
    expect(out.scope).toBe("contacts");
    expect(out.results).toEqual([]);
  });

  it("returns roster entries only when scope asks for them", async () => {
    await seedRoster();
    const out = await searchPeople(ctx, { query: "Hopper", scope: "roster" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toEqual(
      expect.objectContaining({ record_kind: "roster_entry", id: "re_1", source_key: "wcus-2026" })
    );
  });

  it("marks every hit with its record_kind under scope all", async () => {
    await createPerson(ctx, { full_name: "Grace Hopper", organization: "Kinsta" });
    await seedRoster();
    const out = await searchPeople(ctx, { query: "Hopper", scope: "all" });
    expect(out.results).toHaveLength(2);
    const kinds = out.results.map((r) => r.record_kind).sort();
    expect(kinds).toEqual(["person", "roster_entry"]);
    for (const hit of out.results) {
      if (hit.record_kind === "person") expect(hit.id).toMatch(/^p_/);
      else expect(hit.id).toMatch(/^re_/);
    }
  });

  it("returns organization and tags inline so a second call is rarely needed", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    await setTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const out = await searchPeople(ctx, { query: "Lovelace" });
    expect(out.results[0]).toEqual(
      expect.objectContaining({ organization: "Kinsta", tags: ["wcus"] })
    );
  });

  it("excludes archived people unless asked", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    await env.DB.prepare("UPDATE people SET archived_at = ? WHERE id = ?").bind(T, person.id).run();

    expect((await searchPeople(ctx, { query: "Lovelace" })).results).toEqual([]);
    expect(
      (await searchPeople(ctx, { query: "Lovelace", include_archived: true })).results
    ).toHaveLength(1);
  });

  it("treats a query containing FTS operators as literal text", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace" });
    // Must not throw a malformed-MATCH error.
    const out = await searchPeople(ctx, { query: 'Lovelace" OR "' });
    expect(Array.isArray(out.results)).toBe(true);
  });

  it("rejects an empty query", async () => {
    await expect(searchPeople(ctx, { query: "   " })).rejects.toThrow(ToolError);
  });

  it("falls back to prefix matching on a partial word", async () => {
    // "Lov" is not a token, so a bare FTS5 MATCH finds nothing. The spec requires
    // a prefix fallback here, because an agent typing a partial name is normal.
    await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    const out = await searchPeople(ctx, { query: "Lov" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.full_name).toBe("Ada Lovelace");
  });

  it("does not prefix-match a long query that already found nothing", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace" });
    const out = await searchPeople(ctx, { query: "Kubernetes" });
    expect(out.results).toEqual([]);
  });

  it("caps results and reports truncation", async () => {
    for (let i = 0; i < 30; i++) {
      await createPerson(ctx, { full_name: `Tester Kinsta ${i}` });
    }
    const out = await searchPeople(ctx, { query: "Kinsta", limit: 10 });
    expect(out.results).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/search.test.ts`
Expected: FAIL, cannot resolve `../src/tools/search`.

- [ ] **Step 3: Write `src/tools/search.ts`**

The `toMatchQuery` helper is the security-relevant part. A user query is arbitrary text and roster content is written by strangers, so neither is ever interpolated as FTS5 syntax. Each whitespace-separated term has its double quotes stripped and is then wrapped in its own quoted string literal, which turns `Lovelace" OR "` into a set of literal terms rather than a boolean expression.

Quotes are stripped rather than escaped on purpose. Escaping a term that is nothing but a quote character yields an empty string literal, which FTS5 rejects as a syntax error, so the query would fail rather than simply not match. Stripping first and then dropping terms that became empty makes any input safe.

`TAG_SEP` is the ASCII unit separator, written as an escape rather than a literal so the file stays free of control characters. It pairs with `char(31)` in the SQL below and is used because a tag name can contain a comma but cannot contain a control character.

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";

export type SearchScope = "contacts" | "roster" | "all";

const TAG_SEP = "\x1f";

export interface PersonHit {
  record_kind: "person";
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  archived_at: string | null;
  last_encounter_on: string | null;
  tags: string[];
}

export interface RosterHit {
  record_kind: "roster_entry";
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  source_key: string;
  promoted_person_id: string | null;
}

export interface SearchInput {
  query: string;
  scope?: SearchScope;
  include_archived?: boolean;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const PREFIX_MAX_TERM_LENGTH = 5;

export function toMatchQuery(raw: string, prefix = false): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t !== "")
    .map((t) => (prefix ? `"${t}"*` : `"${t}"`))
    .join(" ");
}

/**
 * A short query is one whose longest term is short enough that the user is
 * plausibly typing a partial word. Only those get a second, prefix-matched
 * attempt, so a genuine miss on a long query stays a miss rather than
 * fuzzily matching something unrelated.
 */
export function isShortQuery(raw: string): boolean {
  const terms = raw.trim().split(/\s+/).filter((t) => t !== "");
  return terms.length > 0 && terms.every((t) => t.length <= PREFIX_MAX_TERM_LENGTH);
}

interface PersonRow {
  id: string;
  full_name: string;
  organization: string | null;
  job_title: string | null;
  archived_at: string | null;
  last_encounter_on: string | null;
  tag_blob: string | null;
}

async function matchPeople(
  ctx: ToolContext,
  match: string,
  input: SearchInput,
  probe: number
): Promise<PersonRow[]> {
  if (match === "") return [];
  const { results } = await ctx.db
    .prepare(
      `SELECT p.id AS id, p.full_name AS full_name, p.organization AS organization,
              p.job_title AS job_title, p.archived_at AS archived_at,
              (SELECT MAX(occurred_on) FROM encounters e
                WHERE e.person_id = p.id AND e.deleted_at IS NULL) AS last_encounter_on,
              (SELECT group_concat(t.name, char(31)) FROM person_tags pt
                 JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = p.id) AS tag_blob
       FROM people_fts f
       JOIN people p ON p.rowid = f.rowid
       WHERE people_fts MATCH ?1
         AND (?2 = 1 OR p.archived_at IS NULL)
       ORDER BY bm25(people_fts)
       LIMIT ?3`
    )
    .bind(match, input.include_archived ? 1 : 0, probe)
    .all<PersonRow>();
  return results;
}

export async function searchPeople(
  ctx: ToolContext,
  input: SearchInput
): Promise<{ results: (PersonHit | RosterHit)[]; scope: SearchScope; truncated: boolean }> {
  if (typeof input.query !== "string" || input.query.trim() === "") {
    throw new ToolError("invalid_input", "query is required and must be a non-empty string");
  }
  const scope: SearchScope = input.scope ?? "contacts";
  if (scope !== "contacts" && scope !== "roster" && scope !== "all") {
    throw new ToolError("invalid_input", 'scope must be "contacts", "roster", or "all"');
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const probe = limit + 1;
  const results: (PersonHit | RosterHit)[] = [];

  if (scope === "contacts" || scope === "all") {
    let rows = await matchPeople(ctx, toMatchQuery(input.query), input, probe);
    if (rows.length === 0 && isShortQuery(input.query)) {
      rows = await matchPeople(ctx, toMatchQuery(input.query, true), input, probe);
    }

    for (const r of rows) {
      results.push({
        record_kind: "person",
        id: r.id,
        full_name: r.full_name,
        organization: r.organization,
        job_title: r.job_title,
        archived_at: r.archived_at,
        last_encounter_on: r.last_encounter_on,
        tags: r.tag_blob ? r.tag_blob.split(TAG_SEP) : [],
      });
    }
  }

  if (scope === "roster" || scope === "all") {
    const like = `%${input.query.trim()}%`;
    const { results: rows } = await ctx.db
      .prepare(
        `SELECT re.id AS id, re.full_name AS full_name, re.organization AS organization,
                re.job_title AS job_title, rs.source_key AS source_key,
                (SELECT person_id FROM person_roster_entries pre
                  WHERE pre.roster_entry_id = re.id LIMIT 1) AS promoted_person_id
         FROM roster_entries re
         JOIN roster_sources rs ON rs.id = re.roster_source_id
         WHERE re.retired_at IS NULL
           AND (re.full_name LIKE ?1 OR re.organization LIKE ?1 OR re.job_title LIKE ?1)
         ORDER BY re.full_name
         LIMIT ?2`
      )
      .bind(like, probe)
      .all<{
        id: string;
        full_name: string;
        organization: string | null;
        job_title: string | null;
        source_key: string;
        promoted_person_id: string | null;
      }>();

    for (const r of rows) {
      results.push({ record_kind: "roster_entry", ...r });
    }
  }

  const truncated = results.length > limit;
  return { results: results.slice(0, limit), scope, truncated };
}
```

Roster entries are searched with `LIKE` rather than FTS5 on purpose. Staged rows are disposable and purged wholesale, and a second FTS index over them would cost more in trigger maintenance than it returns. If roster search becomes slow at real volume, that is the moment to add the index, not before.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/search.test.ts`
Expected: PASS, all ten cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search.ts tests/search.test.ts
git commit -m "feat: add search_people with explicit scope and record_kind"
```

---

### Task 10: Encounters

**Files:**
- Create: `src/tools/encounters.ts`, `migrations/0006_encounters_search.sql`
- Modify: `src/tools/people.ts` - `getPerson` returns real `recent_encounters` and `encounter_count`
- Test: `tests/encounters.test.ts`

**Interfaces:**
- Consumes: the `encounters` table from Task 8, `localDate`, `isLocalDate`, `withIdempotency`.
- Produces:
  - `interface Encounter { id: string; record_kind: "encounter"; person_id: string; occurred_on: string; occurred_at: string | null; location: string | null; event: string | null; summary: string; created_at: string }`
  - `function logEncounter(ctx, input): Promise<{ encounter: Encounter; person: PersonDetail }>`
  - `function updateEncounter(ctx, input): Promise<Encounter>`
  - `function deleteEncounter(ctx, input): Promise<{ status: "deleted"; deleted: Encounter }>`
  - `function listEncounters(ctx, input): Promise<{ results: Encounter[]; next_cursor: string | null }>`
  - `function loadRecentEncounters(ctx, personId, limit): Promise<{ results: Encounter[]; total: number }>`

`log_encounter` is the highest-frequency write, is often dictated from a phone, and is the one most likely to be retried on a dropped connection. It takes an `idempotency_key`, and it is correctable, which is why `update_encounter` and `delete_encounter` exist at all.

- [ ] **Step 1: Write the failing test `tests/encounters.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import {
  deleteEncounter,
  listEncounters,
  logEncounter,
  updateEncounter,
} from "../src/tools/encounters";
import { createPerson, getPerson } from "../src/tools/people";

let now = new Date("2026-08-21T02:30:00Z"); // still the 20th in Los Angeles
const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => now,
};

beforeEach(async () => {
  now = new Date("2026-08-21T02:30:00Z");
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("logEncounter", () => {
  it("defaults occurred_on to the owner's local date, not the UTC date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, {
      person_id: person.id,
      summary: "hallway track",
    });
    expect(encounter.occurred_on).toBe("2026-08-20");
    expect(encounter.id).toMatch(/^enc_/);
    expect(encounter.record_kind).toBe("encounter");
  });

  it("returns the full person alongside the encounter", async () => {
    const person = await createPerson(ctx, { full_name: "Ada", organization: "Kinsta" });
    const out = await logEncounter(ctx, { person_id: person.id, summary: "met" });
    expect(out.person.id).toBe(person.id);
    expect(out.person.encounter_count).toBe(1);
    expect(out.person.recent_encounters).toHaveLength(1);
  });

  it("rejects a roster entry id", async () => {
    await expect(
      logEncounter(ctx, { person_id: newId("re"), summary: "met" })
    ).rejects.toThrow(ToolError);
  });

  it("requires a summary", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(logEncounter(ctx, { person_id: person.id, summary: " " })).rejects.toThrow(ToolError);
  });

  it("does not duplicate on a retried call with the same idempotency_key", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const a = await logEncounter(ctx, { person_id: person.id, summary: "met", idempotency_key: "k1" });
    const b = await logEncounter(ctx, { person_id: person.id, summary: "met", idempotency_key: "k1" });
    expect(b.encounter.id).toBe(a.encounter.id);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM encounters").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("accepts an explicit occurred_on local date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, {
      person_id: person.id,
      summary: "met",
      occurred_on: "2026-08-15",
    });
    expect(encounter.occurred_on).toBe("2026-08-15");
  });

  it("rejects an occurred_on that is an instant rather than a local date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      logEncounter(ctx, { person_id: person.id, summary: "met", occurred_on: "2026-08-15T00:00:00Z" })
    ).rejects.toThrow(ToolError);
  });
});

describe("updateEncounter", () => {
  it("corrects a mis-logged summary", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "wrong" });
    const fixed = await updateEncounter(ctx, { encounter_id: encounter.id, summary: "right" });
    expect(fixed.summary).toBe("right");
  });

  it("rejects an unknown encounter", async () => {
    await expect(
      updateEncounter(ctx, { encounter_id: newId("enc"), summary: "x" })
    ).rejects.toThrow(ToolError);
  });
});

describe("deleteEncounter", () => {
  it("removes the encounter in one call, because erasing a mistake is the point", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { encounter } = await logEncounter(ctx, { person_id: person.id, summary: "oops" });
    const out = await deleteEncounter(ctx, { encounter_id: encounter.id });
    expect(out.status).toBe("deleted");
    const detail = await getPerson(ctx, { person_id: person.id });
    expect(detail.encounter_count).toBe(0);
  });
});

describe("listEncounters", () => {
  it("filters by event", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await logEncounter(ctx, { person_id: person.id, summary: "a", event: "WCUS 2026" });
    await logEncounter(ctx, { person_id: person.id, summary: "b", event: "WCEU 2026" });
    const out = await listEncounters(ctx, { event: "WCUS 2026" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.summary).toBe("a");
  });

  it("filters by date range", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await logEncounter(ctx, { person_id: person.id, summary: "old", occurred_on: "2026-01-01" });
    await logEncounter(ctx, { person_id: person.id, summary: "new", occurred_on: "2026-08-15" });
    const out = await listEncounters(ctx, { since: "2026-06-01" });
    expect(out.results.map((e) => e.summary)).toEqual(["new"]);
  });

  it("rejects a since that is not a local date", async () => {
    await expect(listEncounters(ctx, { since: "June" })).rejects.toThrow(ToolError);
  });

  it("paginates with a cursor", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    for (let i = 1; i <= 5; i++) {
      await logEncounter(ctx, {
        person_id: person.id,
        summary: `n${i}`,
        occurred_on: `2026-08-0${i}`,
      });
    }
    const first = await listEncounters(ctx, { person_id: person.id, limit: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = await listEncounters(ctx, {
      person_id: person.id,
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.results).toHaveLength(2);
    const firstIds = first.results.map((e) => e.id);
    const secondIds = second.results.map((e) => e.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/encounters.test.ts`
Expected: FAIL, cannot resolve `../src/tools/encounters`.

- [ ] **Step 3: Write `migrations/0006_encounters_search.sql`**

```sql
CREATE VIRTUAL TABLE encounters_fts USING fts5(
  summary,
  location,
  event,
  content='encounters',
  content_rowid='rowid'
);

CREATE TRIGGER encounters_fts_ai AFTER INSERT ON encounters BEGIN
  INSERT INTO encounters_fts (rowid, summary, location, event)
  VALUES (new.rowid, new.summary, new.location, new.event);
END;

CREATE TRIGGER encounters_fts_ad AFTER DELETE ON encounters BEGIN
  INSERT INTO encounters_fts (encounters_fts, rowid, summary, location, event)
  VALUES ('delete', old.rowid, old.summary, old.location, old.event);
END;

CREATE TRIGGER encounters_fts_au AFTER UPDATE ON encounters BEGIN
  INSERT INTO encounters_fts (encounters_fts, rowid, summary, location, event)
  VALUES ('delete', old.rowid, old.summary, old.location, old.event);
  INSERT INTO encounters_fts (rowid, summary, location, event)
  VALUES (new.rowid, new.summary, new.location, new.event);
END;
```

Two FTS indexes rather than one, per the spec: people and encounters are different entities, and conflating them produces a ranked list an agent cannot explain.

- [ ] **Step 4: Write `src/tools/encounters.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { isLocalDate, localDate, nowIso } from "../time";
import { getPerson, loadPerson, type PersonDetail } from "./people";

export interface Encounter {
  id: string;
  record_kind: "encounter";
  person_id: string;
  occurred_on: string;
  occurred_at: string | null;
  location: string | null;
  event: string | null;
  summary: string;
  created_at: string;
}

interface EncounterRow {
  id: string;
  person_id: string;
  occurred_on: string;
  occurred_at: string | null;
  location: string | null;
  event: string | null;
  summary: string;
  created_at: string;
}

const COLUMNS = "id, person_id, occurred_on, occurred_at, location, event, summary, created_at";

function toEncounter(row: EncounterRow): Encounter {
  return { record_kind: "encounter", ...row };
}

function requireSummary(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError("invalid_input", "summary is required and must be a non-empty string");
  }
  return value.trim();
}

function resolveOccurredOn(ctx: ToolContext, value: unknown): string {
  if (value === undefined || value === null) return localDate(ctx.timezone, ctx.clock());
  if (!isLocalDate(value)) {
    throw new ToolError("invalid_input", "occurred_on must be a YYYY-MM-DD local date");
  }
  return value;
}

export interface LogEncounterInput {
  person_id: string;
  summary: string;
  occurred_on?: string;
  occurred_at?: string | null;
  location?: string | null;
  event?: string | null;
  idempotency_key?: string;
}

export async function logEncounter(
  ctx: ToolContext,
  input: LogEncounterInput
): Promise<{ encounter: Encounter; person: PersonDetail }> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "log_encounter", idempotency_key, rest, async () => {
    const personId = assertId("p", input.person_id);
    await loadPerson(ctx, personId);

    const summary = requireSummary(input.summary);
    const occurredOn = resolveOccurredOn(ctx, input.occurred_on);
    const id = newId("enc");
    const at = nowIso(ctx.clock);

    await ctx.db
      .prepare(
        `INSERT INTO encounters (id, person_id, occurred_on, occurred_at, location, event, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        personId,
        occurredOn,
        input.occurred_at ?? null,
        input.location ?? null,
        input.event ?? null,
        summary,
        at,
        at
      )
      .run();

    return {
      encounter: await loadEncounter(ctx, id),
      person: await getPerson(ctx, { person_id: personId }),
    };
  });
}

export async function loadEncounter(ctx: ToolContext, id: string): Promise<Encounter> {
  const row = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM encounters WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<EncounterRow>();
  if (!row) throw new ToolError("not_found", `no encounter with id ${id}`);
  return toEncounter(row);
}

export interface UpdateEncounterInput {
  encounter_id: string;
  summary?: string;
  occurred_on?: string;
  location?: string | null;
  event?: string | null;
  idempotency_key?: string;
}

export async function updateEncounter(
  ctx: ToolContext,
  input: UpdateEncounterInput
): Promise<Encounter> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "update_encounter", idempotency_key, rest, async () => {
    const id = assertId("enc", input.encounter_id);
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if ("summary" in input) {
      sets.push("summary = ?");
      values.push(requireSummary(input.summary));
    }
    if ("occurred_on" in input) {
      sets.push("occurred_on = ?");
      values.push(resolveOccurredOn(ctx, input.occurred_on));
    }
    if ("location" in input) {
      sets.push("location = ?");
      values.push(input.location ?? null);
    }
    if ("event" in input) {
      sets.push("event = ?");
      values.push(input.event ?? null);
    }
    if (sets.length === 0) {
      throw new ToolError("invalid_input", "update_encounter needs at least one field to change");
    }

    sets.push("updated_at = ?");
    values.push(nowIso(ctx.clock));

    const result = await ctx.db
      .prepare(`UPDATE encounters SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`)
      .bind(...values, id)
      .run();
    if (result.meta.changes === 0) throw new ToolError("not_found", `no encounter with id ${id}`);

    return loadEncounter(ctx, id);
  });
}

export interface DeleteEncounterInput {
  encounter_id: string;
  idempotency_key?: string;
}

export async function deleteEncounter(
  ctx: ToolContext,
  input: DeleteEncounterInput
): Promise<{ status: "deleted"; deleted: Encounter }> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "delete_encounter", idempotency_key, rest, async () => {
    const id = assertId("enc", input.encounter_id);
    const existing = await loadEncounter(ctx, id);
    await ctx.db.prepare("DELETE FROM encounters WHERE id = ?").bind(id).run();
    return { status: "deleted" as const, deleted: existing };
  });
}

export interface ListEncountersInput {
  person_id?: string;
  event?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

export async function listEncounters(
  ctx: ToolContext,
  input: ListEncountersInput
): Promise<{ results: Encounter[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const clauses = ["deleted_at IS NULL"];
  const values: (string | number)[] = [];

  if (input.person_id !== undefined) {
    clauses.push("person_id = ?");
    values.push(assertId("p", input.person_id));
  }
  if (input.event !== undefined) {
    clauses.push("event = ?");
    values.push(input.event);
  }
  for (const [key, op] of [["since", ">="], ["until", "<="]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!isLocalDate(value)) {
      throw new ToolError("invalid_input", `${key} must be a YYYY-MM-DD local date`);
    }
    clauses.push(`occurred_on ${op} ?`);
    values.push(value);
  }
  if (input.cursor !== undefined) {
    clauses.push("id > ?");
    values.push(assertId("enc", input.cursor));
  }

  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM encounters
       WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_on DESC, id ASC
       LIMIT ?`
    )
    .bind(...values, limit + 1)
    .all<EncounterRow>();

  const page = results.slice(0, limit).map(toEncounter);
  const next = results.length > limit ? (page[page.length - 1]?.id ?? null) : null;
  return { results: page, next_cursor: next };
}

export async function loadRecentEncounters(
  ctx: ToolContext,
  personId: string,
  limit: number
): Promise<{ results: Encounter[]; total: number }> {
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM encounters
       WHERE person_id = ? AND deleted_at IS NULL
       ORDER BY occurred_on DESC, id DESC LIMIT ?`
    )
    .bind(personId, limit)
    .all<EncounterRow>();

  const count = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM encounters WHERE person_id = ? AND deleted_at IS NULL")
    .bind(personId)
    .first<{ n: number }>();

  return { results: results.map(toEncounter), total: count?.n ?? 0 };
}
```

The cursor is the last id of the page, and pagination filters on `id > cursor`. Ids are unique, which is why `ORDER BY` ends in `id ASC` and why the cursor is stable across pages.

- [ ] **Step 5: Modify `getPerson` in `src/tools/people.ts`**

Replace the two stubbed encounter fields in the return:

```ts
  const { loadRecentEncounters } = await import("./encounters");
  const encounters = await loadRecentEncounters(ctx, id, input.encounter_limit ?? 10);
  return {
    ...person,
    contacts,
    links,
    tags,
    sources: [],
    open_followups: [],
    recent_encounters: encounters.results,
    encounter_count: encounters.total,
  };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/encounters.test.ts tests/people.test.ts tests/people-lifecycle.test.ts`
Expected: PASS. `tests/people.test.ts` still passes because a person with no encounters has an empty list and a count of zero.

- [ ] **Step 7: Commit**

```bash
git add src/tools/encounters.ts migrations/0006_encounters_search.sql src/tools/people.ts tests/encounters.test.ts
git commit -m "feat: add encounter logging, correction, deletion, and listing"
```

---

### Task 11: Follow-ups and `list_due`

**Files:**
- Create: `src/tools/followups.ts`
- Modify: `src/tools/people.ts` - `getPerson` returns real `open_followups`
- Test: `tests/followups.test.ts`

**Interfaces:**
- Consumes: the `followups` table from Task 8, `localDate`, `isLocalDate`.
- Produces:
  - `interface Followup { id: string; record_kind: "followup"; person_id: string; due_on: string; note: string | null; completed_at: string | null; cancelled_at: string | null }`
  - `interface DueItem extends Followup { person_name: string; days_overdue: number }`
  - `function setFollowup(ctx, input): Promise<{ followup: Followup; person: PersonDetail }>`
  - `function completeFollowup(ctx, input): Promise<Followup>`
  - `function cancelFollowup(ctx, input): Promise<Followup>`
  - `function listDue(ctx, input): Promise<{ results: DueItem[]; as_of: string; timezone: string }>`
  - `function loadOpenFollowups(ctx, personId): Promise<Followup[]>`

`list_due` is the tool that answers "what am I forgetting." Its correctness depends entirely on the time zone: `due_on` is a local date, "today" is computed in `ctx.timezone`, and comparing either against a UTC instant is the bug this task is written to prevent.

- [ ] **Step 1: Write the failing test `tests/followups.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import {
  cancelFollowup,
  completeFollowup,
  listDue,
  setFollowup,
} from "../src/tools/followups";
import { createPerson, getPerson } from "../src/tools/people";

let now = new Date("2026-08-21T02:30:00Z"); // the 20th in Los Angeles, the 21st in UTC
const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => now,
};

beforeEach(async () => {
  now = new Date("2026-08-21T02:30:00Z");
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("setFollowup", () => {
  it("stores a local due date and returns the person", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const out = await setFollowup(ctx, {
      person_id: person.id,
      due_on: "2026-08-25",
      note: "send the deck",
    });
    expect(out.followup.id).toMatch(/^fu_/);
    expect(out.followup.due_on).toBe("2026-08-25");
    expect(out.person.open_followups).toHaveLength(1);
  });

  it("rejects an instant where a local date belongs", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      setFollowup(ctx, { person_id: person.id, due_on: "2026-08-25T00:00:00Z" })
    ).rejects.toThrow(ToolError);
  });

  it("rejects vague text rather than guessing", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(setFollowup(ctx, { person_id: person.id, due_on: "tomorrow" })).rejects.toThrow(
      ToolError
    );
  });

  it("rejects a roster entry id", async () => {
    await expect(
      setFollowup(ctx, { person_id: newId("re"), due_on: "2026-08-25" })
    ).rejects.toThrow(ToolError);
  });
});

describe("completeFollowup and cancelFollowup", () => {
  it("completing closes it out and removes it from the person's open list", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await setFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    const done = await completeFollowup(ctx, { followup_id: followup.id });
    expect(done.completed_at).not.toBeNull();
    const detail = await getPerson(ctx, { person_id: person.id });
    expect(detail.open_followups).toEqual([]);
  });

  it("cancelling is distinct from completing", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await setFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    const cancelled = await cancelFollowup(ctx, { followup_id: followup.id });
    expect(cancelled.cancelled_at).not.toBeNull();
    expect(cancelled.completed_at).toBeNull();
  });

  it("refuses to complete an already-completed follow-up", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const { followup } = await setFollowup(ctx, { person_id: person.id, due_on: "2026-08-25" });
    await completeFollowup(ctx, { followup_id: followup.id });
    await expect(completeFollowup(ctx, { followup_id: followup.id })).rejects.toThrow(ToolError);
  });
});

describe("listDue", () => {
  it("computes today in the owner's zone, not in UTC", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    // Due on the 20th. In Los Angeles it is the 20th, so this is due today, not overdue.
    await setFollowup(ctx, { person_id: person.id, due_on: "2026-08-20" });
    const out = await listDue(ctx, {});
    expect(out.as_of).toBe("2026-08-20");
    expect(out.timezone).toBe("America/Los_Angeles");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.days_overdue).toBe(0);
  });

  it("puts the most overdue first and names the person inline", async () => {
    const a = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const b = await createPerson(ctx, { full_name: "Grace Hopper" });
    await setFollowup(ctx, { person_id: a.id, due_on: "2026-08-18" });
    await setFollowup(ctx, { person_id: b.id, due_on: "2026-08-10" });

    const out = await listDue(ctx, {});
    expect(out.results.map((r) => r.person_name)).toEqual(["Grace Hopper", "Ada Lovelace"]);
    expect(out.results[0]?.days_overdue).toBe(10);
    expect(out.results[1]?.days_overdue).toBe(2);
  });

  it("excludes future follow-ups unless a horizon is given", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await setFollowup(ctx, { person_id: person.id, due_on: "2026-09-30" });
    expect((await listDue(ctx, {})).results).toEqual([]);
    expect((await listDue(ctx, { through: "2026-10-01" })).results).toHaveLength(1);
  });

  it("excludes completed and cancelled follow-ups", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const one = await setFollowup(ctx, { person_id: person.id, due_on: "2026-08-01" });
    const two = await setFollowup(ctx, { person_id: person.id, due_on: "2026-08-02" });
    await completeFollowup(ctx, { followup_id: one.followup.id });
    await cancelFollowup(ctx, { followup_id: two.followup.id });
    expect((await listDue(ctx, {})).results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/followups.test.ts`
Expected: FAIL, cannot resolve `../src/tools/followups`.

- [ ] **Step 3: Write `src/tools/followups.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { isLocalDate, localDate, nowIso } from "../time";
import { getPerson, loadPerson, type PersonDetail } from "./people";

export interface Followup {
  id: string;
  record_kind: "followup";
  person_id: string;
  due_on: string;
  note: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface DueItem extends Followup {
  person_name: string;
  days_overdue: number;
}

interface FollowupRow {
  id: string;
  person_id: string;
  due_on: string;
  note: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

const COLUMNS = "id, person_id, due_on, note, completed_at, cancelled_at";
const OPEN = "completed_at IS NULL AND cancelled_at IS NULL";

function toFollowup(row: FollowupRow): Followup {
  return { record_kind: "followup", ...row };
}

function requireLocalDate(value: unknown, field: string): string {
  if (!isLocalDate(value)) {
    throw new ToolError(
      "invalid_input",
      `${field} must be a YYYY-MM-DD local date interpreted in the owner's time zone`
    );
  }
  return value;
}

function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const day = 24 * 60 * 60 * 1000;
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const to = Date.parse(`${toIsoDate}T00:00:00Z`);
  return Math.round((to - from) / day);
}

export interface SetFollowupInput {
  person_id: string;
  due_on: string;
  note?: string | null;
  idempotency_key?: string;
}

export async function setFollowup(
  ctx: ToolContext,
  input: SetFollowupInput
): Promise<{ followup: Followup; person: PersonDetail }> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "set_followup", idempotency_key, rest, async () => {
    const personId = assertId("p", input.person_id);
    await loadPerson(ctx, personId);
    const dueOn = requireLocalDate(input.due_on, "due_on");

    const id = newId("fu");
    const at = nowIso(ctx.clock);
    await ctx.db
      .prepare(
        `INSERT INTO followups (id, person_id, due_on, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, personId, dueOn, input.note ?? null, at, at)
      .run();

    return {
      followup: await loadFollowup(ctx, id),
      person: await getPerson(ctx, { person_id: personId }),
    };
  });
}

export async function loadFollowup(ctx: ToolContext, id: string): Promise<Followup> {
  const row = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM followups WHERE id = ?`)
    .bind(id)
    .first<FollowupRow>();
  if (!row) throw new ToolError("not_found", `no follow-up with id ${id}`);
  return toFollowup(row);
}

export interface CloseFollowupInput {
  followup_id: string;
  idempotency_key?: string;
}

async function closeFollowup(
  ctx: ToolContext,
  input: CloseFollowupInput,
  tool: string,
  column: "completed_at" | "cancelled_at"
): Promise<Followup> {
  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, tool, idempotency_key, rest, async () => {
    const id = assertId("fu", input.followup_id);
    const result = await ctx.db
      .prepare(`UPDATE followups SET ${column} = ?, updated_at = ? WHERE id = ? AND ${OPEN}`)
      .bind(nowIso(ctx.clock), nowIso(ctx.clock), id)
      .run();

    if (result.meta.changes === 0) {
      const existing = await ctx.db
        .prepare("SELECT id FROM followups WHERE id = ?")
        .bind(id)
        .first<{ id: string }>();
      if (!existing) throw new ToolError("not_found", `no follow-up with id ${id}`);
      throw new ToolError("conflict", `follow-up ${id} is already closed`);
    }

    return loadFollowup(ctx, id);
  });
}

export function completeFollowup(ctx: ToolContext, input: CloseFollowupInput): Promise<Followup> {
  return closeFollowup(ctx, input, "complete_followup", "completed_at");
}

export function cancelFollowup(ctx: ToolContext, input: CloseFollowupInput): Promise<Followup> {
  return closeFollowup(ctx, input, "cancel_followup", "cancelled_at");
}

export interface ListDueInput {
  through?: string;
  limit?: number;
}

export async function listDue(
  ctx: ToolContext,
  input: ListDueInput
): Promise<{ results: DueItem[]; as_of: string; timezone: string }> {
  const asOf = localDate(ctx.timezone, ctx.clock());
  const through = input.through === undefined ? asOf : requireLocalDate(input.through, "through");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const { results } = await ctx.db
    .prepare(
      `SELECT f.id AS id, f.person_id AS person_id, f.due_on AS due_on, f.note AS note,
              f.completed_at AS completed_at, f.cancelled_at AS cancelled_at,
              p.full_name AS person_name
       FROM followups f
       JOIN people p ON p.id = f.person_id
       WHERE ${OPEN.replace(/\b(completed_at|cancelled_at)\b/g, "f.$1")}
         AND f.due_on <= ?
       ORDER BY f.due_on ASC, f.id ASC
       LIMIT ?`
    )
    .bind(through, limit)
    .all<FollowupRow & { person_name: string }>();

  return {
    results: results.map((row) => ({
      ...toFollowup(row),
      person_name: row.person_name,
      days_overdue: Math.max(daysBetween(row.due_on, asOf), 0),
    })),
    as_of: asOf,
    timezone: ctx.timezone,
  };
}

export async function loadOpenFollowups(ctx: ToolContext, personId: string): Promise<Followup[]> {
  const { results } = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM followups WHERE person_id = ? AND ${OPEN} ORDER BY due_on ASC`)
    .bind(personId)
    .all<FollowupRow>();
  return results.map(toFollowup);
}
```

`daysBetween` parses both dates as UTC midnight deliberately. Both operands are already local dates in the same zone, so the arithmetic is a plain calendar-day difference and introducing a zone here would double-apply the offset.

- [ ] **Step 4: Modify `getPerson` in `src/tools/people.ts`**

Replace the stubbed `open_followups`:

```ts
  const { loadOpenFollowups } = await import("./followups");
  const openFollowups = await loadOpenFollowups(ctx, id);
```

and return `open_followups: openFollowups`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/followups.test.ts tests/people.test.ts`
Expected: PASS, all eleven follow-up cases.

- [ ] **Step 6: Commit**

```bash
git add src/tools/followups.ts src/tools/people.ts tests/followups.test.ts
git commit -m "feat: add follow-ups and timezone-correct list_due"
```

---

### Task 12: Resumable roster import

**Files:**
- Create: `src/tools/import.ts`
- Test: `tests/import.test.ts`

**Interfaces:**
- Consumes: `roster_sources`, `import_runs`, `roster_entries` from Task 3; `hashJson`.
- Produces:
  - `const IMPORT_BATCH_LIMIT = 200`
  - `interface RosterRow { external_row_key?: string; full_name: string; preferred_name?: string; job_title?: string; organization?: string; email?: string; role?: string; raw?: unknown }`
  - `interface ImportResult { run_id: string; roster_source_id: string; imported: number; updated: number; skipped: number; total_seen: number; next_cursor: string | null; errors: { index: number; reason: string }[] }`
  - `function importRoster(ctx, input): Promise<ImportResult>`
  - `function finalizeImport(ctx, input): Promise<{ run_id: string; retired: number; status: "committed" }>`
  - `function parseCsv(text: string): Record<string, string>[]`

This is the task the spec rewrote after review. The old design passed a whole CSV through one call. That cannot work: free-plan D1 allows 50 queries per Worker invocation and 100 bound parameters per query, and an MCP call is one-shot so a server cannot report progress mid-call. Import is a protocol, and the agent loops.

- [ ] **Step 1: Write the failing test `tests/import.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { finalizeImport, importRoster, parseCsv, IMPORT_BATCH_LIMIT } from "../src/tools/import";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

const SOURCE = {
  source_key: "wcus-2026",
  label: "WordCamp US 2026",
  event: "WCUS 2026",
  source_url: "https://example.test/attendees",
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
});

describe("parseCsv", () => {
  it("parses a header row and quoted fields containing commas", () => {
    const rows = parseCsv('full_name,organization\n"Lovelace, Ada",Kinsta\n');
    expect(rows).toEqual([{ full_name: "Lovelace, Ada", organization: "Kinsta" }]);
  });

  it("handles escaped quotes", () => {
    const rows = parseCsv('full_name\n"Ada ""The Countess"" Lovelace"\n');
    expect(rows[0]?.full_name).toBe('Ada "The Countess" Lovelace');
  });

  it("ignores a trailing blank line", () => {
    expect(parseCsv("full_name\nAda\n\n")).toHaveLength(1);
  });
});

describe("importRoster", () => {
  it("creates the source and run on the first call", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", organization: "Kinsta" }],
    });
    expect(out.run_id).toMatch(/^ir_/);
    expect(out.roster_source_id).toMatch(/^rs_/);
    expect(out.imported).toBe(1);
    expect(out.next_cursor).toBeNull();
  });

  it("is idempotent on re-import of the same rows", async () => {
    const rows = [{ external_row_key: "1", full_name: "Ada Lovelace" }];
    const first = await importRoster(ctx, { ...SOURCE, format: "json", rows });
    const second = await importRoster(ctx, { ...SOURCE, format: "json", rows });
    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("derives a stable row key by content hash when the source has none", async () => {
    const rows = [{ full_name: "Ada Lovelace", organization: "Kinsta" }];
    await importRoster(ctx, { ...SOURCE, format: "json", rows });
    await importRoster(ctx, { ...SOURCE, format: "json", rows });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("never treats a name as an identity", async () => {
    // Two different people with the same name and different row keys must both land.
    await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows: [
        { external_row_key: "1", full_name: "Chris Smith", organization: "A" },
        { external_row_key: "2", full_name: "Chris Smith", organization: "B" },
      ],
    });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("caps a batch at the server constant and returns a cursor", async () => {
    const rows = Array.from({ length: IMPORT_BATCH_LIMIT + 25 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    const first = await importRoster(ctx, { ...SOURCE, format: "json", rows });
    expect(first.imported).toBe(IMPORT_BATCH_LIMIT);
    expect(first.next_cursor).toBe(String(IMPORT_BATCH_LIMIT));

    const second = await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows,
      run_id: first.run_id,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.imported).toBe(25);
    expect(second.next_cursor).toBeNull();
  });

  it("reports per-row errors instead of failing the whole batch", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace" },
        { external_row_key: "2", full_name: "   " },
      ],
    });
    expect(out.imported).toBe(1);
    expect(out.errors).toEqual([{ index: 1, reason: "full_name is required" }]);
  });

  it("stores provenance on every row", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }],
    });
    const row = await env.DB.prepare(
      "SELECT source_url, source_captured_at, raw_record FROM roster_entries LIMIT 1"
    ).first<{ source_url: string; source_captured_at: string; raw_record: string }>();
    expect(row?.source_url).toBe(SOURCE.source_url);
    expect(row?.source_captured_at).toBe("2026-08-20T12:00:00.000Z");
    expect(JSON.parse(row?.raw_record ?? "{}")).toEqual(
      expect.objectContaining({ full_name: "Ada Lovelace" })
    );
  });

  it("rejects a rows argument that is not an array", async () => {
    await expect(
      importRoster(ctx, { ...SOURCE, format: "json", rows: "not an array" as never })
    ).rejects.toThrow(ToolError);
  });
});

describe("finalizeImport", () => {
  it("retires rows the run did not see when it claims full coverage", async () => {
    const first = await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id, full_coverage: true });

    const second = await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const out = await finalizeImport(ctx, { run_id: second.run_id, full_coverage: true });
    expect(out.retired).toBe(1);

    const retired = await env.DB.prepare(
      "SELECT retired_at FROM roster_entries WHERE external_row_key = ?"
    )
      .bind("2")
      .first<{ retired_at: string | null }>();
    expect(retired?.retired_at).not.toBeNull();
  });

  it("retires nothing for a partial paste", async () => {
    const first = await importRoster(ctx, {
      ...SOURCE,
      format: "json",
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id, full_coverage: true });

    const second = await importRoster(ctx, {
      ...SOURCE,
      format: "text",
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const out = await finalizeImport(ctx, { run_id: second.run_id, full_coverage: false });
    expect(out.retired).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/import.test.ts`
Expected: FAIL, cannot resolve `../src/tools/import`.

- [ ] **Step 3: Write `src/tools/import.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { newId } from "../ids";
import { hashJson } from "../idempotency";
import { nowIso } from "../time";

export const IMPORT_BATCH_LIMIT = 200;

export interface RosterRow {
  external_row_key?: string;
  full_name: string;
  preferred_name?: string;
  job_title?: string;
  organization?: string;
  email?: string;
  role?: string;
  raw?: unknown;
}

export interface ImportResult {
  run_id: string;
  roster_source_id: string;
  imported: number;
  updated: number;
  skipped: number;
  total_seen: number;
  next_cursor: string | null;
  errors: { index: number; reason: string }[];
}

export interface ImportRosterInput {
  source_key: string;
  label: string;
  source_url: string;
  format: "csv" | "json" | "text";
  rows: RosterRow[];
  event?: string;
  run_id?: string;
  cursor?: string;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];

  return body
    .filter((cells) => cells.some((c) => c.trim() !== ""))
    .map((cells) => {
      const record: Record<string, string> = {};
      header.forEach((name, index) => {
        record[name.trim()] = (cells[index] ?? "").trim();
      });
      return record;
    });
}

async function rowKey(row: RosterRow): Promise<string> {
  if (typeof row.external_row_key === "string" && row.external_row_key.trim() !== "") {
    return row.external_row_key.trim();
  }
  const { external_row_key, raw, ...content } = row;
  return `sha256:${await hashJson(content)}`;
}

async function ensureSource(ctx: ToolContext, input: ImportRosterInput): Promise<string> {
  const existing = await ctx.db
    .prepare("SELECT id FROM roster_sources WHERE source_key = ?")
    .bind(input.source_key)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = newId("rs");
  await ctx.db
    .prepare(
      "INSERT INTO roster_sources (id, source_key, label, event, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(id, input.source_key, input.label, input.event ?? null, input.source_url, nowIso(ctx.clock))
    .run();
  return id;
}

export async function importRoster(
  ctx: ToolContext,
  input: ImportRosterInput
): Promise<ImportResult> {
  if (!Array.isArray(input.rows)) {
    throw new ToolError("invalid_input", "rows must be an array");
  }
  if (typeof input.source_key !== "string" || input.source_key.trim() === "") {
    throw new ToolError("invalid_input", "source_key is required");
  }

  const sourceId = await ensureSource(ctx, input);
  const at = nowIso(ctx.clock);

  let runId = input.run_id;
  if (!runId) {
    runId = newId("ir");
    await ctx.db
      .prepare(
        "INSERT INTO import_runs (id, roster_source_id, format, input_hash, status, started_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(runId, sourceId, input.format, await hashJson(input.rows), "open", at)
      .run();
  }

  const start = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isInteger(start) || start < 0) {
    throw new ToolError("invalid_input", "cursor must be a non-negative integer");
  }

  const slice = input.rows.slice(start, start + IMPORT_BATCH_LIMIT);
  const errors: { index: number; reason: string }[] = [];
  let imported = 0;
  let updated = 0;

  for (let offset = 0; offset < slice.length; offset++) {
    const row = slice[offset]!;
    if (typeof row.full_name !== "string" || row.full_name.trim() === "") {
      errors.push({ index: start + offset, reason: "full_name is required" });
      continue;
    }

    const key = await rowKey(row);
    const result = await ctx.db
      .prepare(
        `INSERT INTO roster_entries
           (id, roster_source_id, external_row_key, full_name, preferred_name, job_title,
            organization, email, role, source_url, source_captured_at, raw_record,
            last_seen_run_id, retired_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT (roster_source_id, external_row_key) DO UPDATE SET
           full_name = excluded.full_name,
           preferred_name = excluded.preferred_name,
           job_title = excluded.job_title,
           organization = excluded.organization,
           email = excluded.email,
           role = excluded.role,
           source_captured_at = excluded.source_captured_at,
           raw_record = excluded.raw_record,
           last_seen_run_id = excluded.last_seen_run_id,
           retired_at = NULL,
           updated_at = excluded.updated_at`
      )
      .bind(
        newId("re"),
        sourceId,
        key,
        row.full_name.trim(),
        row.preferred_name ?? null,
        row.job_title ?? null,
        row.organization ?? null,
        row.email ?? null,
        row.role ?? null,
        input.source_url,
        at,
        JSON.stringify(row.raw ?? row),
        runId,
        at,
        at
      )
      .run();

    // meta.changes is 1 for an insert and 2 for an upsert that replaced a row in SQLite's
    // total_changes accounting; compare last_row_id instead by re-reading the run marker.
    if (result.meta.changes === 1 && result.meta.last_row_id !== 0) imported++;
    else updated++;
  }

  const consumed = start + slice.length;
  const nextCursor = consumed < input.rows.length ? String(consumed) : null;

  await ctx.db
    .prepare(
      `UPDATE import_runs
         SET inserted_count = inserted_count + ?, updated_count = updated_count + ?, skipped_count = skipped_count + ?
       WHERE id = ?`
    )
    .bind(imported, updated, errors.length, runId)
    .run();

  return {
    run_id: runId,
    roster_source_id: sourceId,
    imported,
    updated,
    skipped: errors.length,
    total_seen: input.rows.length,
    next_cursor: nextCursor,
    errors,
  };
}

export interface FinalizeImportInput {
  run_id: string;
  full_coverage: boolean;
}

export async function finalizeImport(
  ctx: ToolContext,
  input: FinalizeImportInput
): Promise<{ run_id: string; retired: number; status: "committed" }> {
  const run = await ctx.db
    .prepare("SELECT id, roster_source_id FROM import_runs WHERE id = ?")
    .bind(input.run_id)
    .first<{ id: string; roster_source_id: string }>();
  if (!run) throw new ToolError("not_found", `no import run with id ${input.run_id}`);

  const at = nowIso(ctx.clock);
  let retired = 0;

  if (input.full_coverage) {
    const result = await ctx.db
      .prepare(
        `UPDATE roster_entries
           SET retired_at = ?, updated_at = ?
         WHERE roster_source_id = ? AND last_seen_run_id != ? AND retired_at IS NULL`
      )
      .bind(at, at, run.roster_source_id, run.id)
      .run();
    retired = result.meta.changes;
  }

  await ctx.db
    .prepare(
      "UPDATE import_runs SET status = 'committed', full_coverage = ?, retired_count = ?, finished_at = ? WHERE id = ?"
    )
    .bind(input.full_coverage ? 1 : 0, retired, at, run.id)
    .run();

  return { run_id: run.id, retired, status: "committed" };
}
```

**Note on counting inserts against updates:** D1's `meta.changes` does not distinguish an insert from an `ON CONFLICT DO UPDATE` reliably across versions. If the "is idempotent on re-import" test fails on the imported-versus-updated split rather than on the row count, replace the counting with an explicit pre-check: `SELECT id FROM roster_entries WHERE roster_source_id = ? AND external_row_key = ?` before each write, and increment based on whether that returned a row. It costs one extra query per row, which still fits inside the batch limit, and the row count is the assertion that actually matters.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/import.test.ts`
Expected: PASS, all thirteen cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/import.ts tests/import.test.ts
git commit -m "feat: add resumable roster import with content-hash row keys"
```

---

### Task 13: Two-phase `promote`

**Files:**
- Create: `src/tools/promote.ts`
- Modify: `src/tools/people.ts` - `getPerson` returns real `sources`
- Test: `tests/promote.test.ts`

**Interfaces:**
- Consumes: `roster_entries`, `person_sources`, `person_roster_entries`, `createPerson`.
- Produces:
  - `interface DuplicateCandidate { person_id: string; full_name: string; organization: string | null; evidence: string[]; score: number }`
  - `type PromoteResult = { status: "candidates"; roster_entry_id: string; preview: RosterRow; candidates: DuplicateCandidate[] } | { status: "promoted"; person: PersonDetail; linked_existing: boolean }`
  - `function promote(ctx, input): Promise<PromoteResult>`
  - `function loadPersonSources(ctx, personId): Promise<Source[]>`

Promotion is two calls because surfacing candidates and committing cannot happen in one: the agent has to see the candidates before choosing. The first call writes nothing. The second either links to a person the caller names or creates a new one. It never decides for itself, and it never merges, because a tolerated duplicate is cheap and an unreversible bad merge is not.

- [ ] **Step 1: Write the failing test `tests/promote.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import { addContact } from "../src/tools/attributes";
import { importRoster } from "../src/tools/import";
import { createPerson, getPerson } from "../src/tools/people";
import { promote } from "../src/tools/promote";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

const SOURCE = {
  source_key: "wcus-2026",
  label: "WCUS 2026",
  event: "WCUS 2026",
  source_url: "https://example.test/attendees",
  format: "json" as const,
};

async function importOne(row: Record<string, unknown>): Promise<string> {
  await importRoster(ctx, { ...SOURCE, rows: [row as never] });
  const entry = await env.DB.prepare(
    "SELECT id FROM roster_entries ORDER BY created_at DESC LIMIT 1"
  ).first<{ id: string }>();
  return entry!.id;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
});

describe("promote, first phase", () => {
  it("writes nothing and returns candidates", async () => {
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada Lovelace" });
    const out = await promote(ctx, { roster_entry_id: entryId });

    expect(out.status).toBe("candidates");
    if (out.status !== "candidates") throw new Error("unreachable");
    expect(out.preview.full_name).toBe("Ada Lovelace");

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("surfaces an exact-name match as a candidate with its evidence", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    const entryId = await importOne({
      external_row_key: "1",
      full_name: "Ada Lovelace",
      organization: "Kinsta",
    });

    const out = await promote(ctx, { roster_entry_id: entryId });
    if (out.status !== "candidates") throw new Error("unreachable");
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]?.evidence).toEqual(
      expect.arrayContaining(["same name", "same organization"])
    );
  });

  it("surfaces a shared email as the strongest evidence", async () => {
    const person = await createPerson(ctx, { full_name: "A Different Name" });
    await addContact(ctx, {
      person_id: person.id,
      contact_type: "email",
      value: "ada@example.test",
    });
    const entryId = await importOne({
      external_row_key: "1",
      full_name: "Ada Lovelace",
      email: "ada@example.test",
    });

    const out = await promote(ctx, { roster_entry_id: entryId });
    if (out.status !== "candidates") throw new Error("unreachable");
    expect(out.candidates[0]?.person_id).toBe(person.id);
    expect(out.candidates[0]?.evidence).toContain("same email");
  });

  it("returns no candidates for a genuinely new person", async () => {
    await createPerson(ctx, { full_name: "Grace Hopper" });
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada Lovelace" });
    const out = await promote(ctx, { roster_entry_id: entryId });
    if (out.status !== "candidates") throw new Error("unreachable");
    expect(out.candidates).toEqual([]);
  });

  it("rejects a person id where a roster entry id belongs", async () => {
    await expect(promote(ctx, { roster_entry_id: newId("p") })).rejects.toThrow(ToolError);
  });
});

describe("promote, second phase", () => {
  it("creates a new person and copies provenance into durable storage", async () => {
    const entryId = await importOne({
      external_row_key: "1",
      full_name: "Ada Lovelace",
      organization: "Kinsta",
      email: "ada@example.test",
    });
    const out = await promote(ctx, { roster_entry_id: entryId, create_new: true });

    expect(out.status).toBe("promoted");
    if (out.status !== "promoted") throw new Error("unreachable");
    expect(out.linked_existing).toBe(false);
    expect(out.person.full_name).toBe("Ada Lovelace");
    expect(out.person.organization).toBe("Kinsta");
    expect(out.person.contacts).toEqual([
      expect.objectContaining({ contact_type: "email", value: "ada@example.test" }),
    ]);
    expect(out.person.sources).toEqual([
      expect.objectContaining({ source_key: "wcus-2026", external_row_key: "1" }),
    ]);
  });

  it("links to an existing person without creating a second one", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace" });
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada Lovelace" });
    const out = await promote(ctx, {
      roster_entry_id: entryId,
      link_to_person_id: person.id,
    });

    if (out.status !== "promoted") throw new Error("unreachable");
    expect(out.linked_existing).toBe(true);
    expect(out.person.id).toBe(person.id);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("refuses when both link_to_person_id and create_new are given", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada" });
    await expect(
      promote(ctx, { roster_entry_id: entryId, link_to_person_id: person.id, create_new: true })
    ).rejects.toThrow(ToolError);
  });

  it("is idempotent: promoting the same entry twice does not create two people", async () => {
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada Lovelace" });
    await promote(ctx, { roster_entry_id: entryId, create_new: true });
    await promote(ctx, { roster_entry_id: entryId, create_new: true });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("keeps provenance after the staged source is purged", async () => {
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada Lovelace" });
    const out = await promote(ctx, { roster_entry_id: entryId, create_new: true });
    if (out.status !== "promoted") throw new Error("unreachable");

    await env.DB.prepare("DELETE FROM roster_sources").run();

    const detail = await getPerson(ctx, { person_id: out.person.id });
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]).toEqual(
      expect.objectContaining({ source_key: "wcus-2026", external_row_key: "1" })
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/promote.test.ts`
Expected: FAIL, cannot resolve `../src/tools/promote`.

- [ ] **Step 3: Write `src/tools/promote.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { nowIso } from "../time";
import { addContact } from "./attributes";
import { createPerson, getPerson, type PersonDetail } from "./people";

export interface Source {
  id: string;
  source_key: string;
  external_row_key: string;
  source_url: string;
  source_captured_at: string;
  promoted_at: string;
}

export interface DuplicateCandidate {
  person_id: string;
  full_name: string;
  organization: string | null;
  evidence: string[];
  score: number;
}

interface EntryRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  organization: string | null;
  email: string | null;
  role: string | null;
  source_url: string;
  source_captured_at: string;
  raw_record: string;
  source_key: string;
  external_row_key: string;
}

export type PromoteResult =
  | {
      status: "candidates";
      roster_entry_id: string;
      preview: Omit<EntryRow, "raw_record">;
      candidates: DuplicateCandidate[];
    }
  | { status: "promoted"; person: PersonDetail; linked_existing: boolean };

export interface PromoteInput {
  roster_entry_id: string;
  link_to_person_id?: string;
  create_new?: boolean;
}

export async function loadPersonSources(ctx: ToolContext, personId: string): Promise<Source[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT id, source_key, external_row_key, source_url, source_captured_at, promoted_at
       FROM person_sources WHERE person_id = ? ORDER BY promoted_at`
    )
    .bind(personId)
    .all<Source>();
  return results;
}

async function loadEntry(ctx: ToolContext, id: string): Promise<EntryRow> {
  const row = await ctx.db
    .prepare(
      `SELECT re.id AS id, re.full_name AS full_name, re.preferred_name AS preferred_name,
              re.job_title AS job_title, re.organization AS organization, re.email AS email,
              re.role AS role, re.source_url AS source_url,
              re.source_captured_at AS source_captured_at, re.raw_record AS raw_record,
              re.external_row_key AS external_row_key, rs.source_key AS source_key
       FROM roster_entries re
       JOIN roster_sources rs ON rs.id = re.roster_source_id
       WHERE re.id = ?`
    )
    .bind(id)
    .first<EntryRow>();
  if (!row) throw new ToolError("not_found", `no roster entry with id ${id}`);
  return row;
}

async function findCandidates(ctx: ToolContext, entry: EntryRow): Promise<DuplicateCandidate[]> {
  const found = new Map<string, DuplicateCandidate>();

  const add = (
    person: { id: string; full_name: string; organization: string | null },
    evidence: string,
    weight: number
  ) => {
    const existing = found.get(person.id);
    if (existing) {
      if (!existing.evidence.includes(evidence)) {
        existing.evidence.push(evidence);
        existing.score += weight;
      }
      return;
    }
    found.set(person.id, {
      person_id: person.id,
      full_name: person.full_name,
      organization: person.organization,
      evidence: [evidence],
      score: weight,
    });
  };

  if (entry.email) {
    const { results } = await ctx.db
      .prepare(
        `SELECT p.id AS id, p.full_name AS full_name, p.organization AS organization
         FROM person_contacts pc JOIN people p ON p.id = pc.person_id
         WHERE pc.contact_type = 'email' AND lower(pc.value) = lower(?)`
      )
      .bind(entry.email)
      .all<{ id: string; full_name: string; organization: string | null }>();
    for (const person of results) add(person, "same email", 100);
  }

  const { results: byName } = await ctx.db
    .prepare(
      `SELECT id, full_name, organization FROM people
       WHERE lower(full_name) = lower(?) AND archived_at IS NULL`
    )
    .bind(entry.full_name)
    .all<{ id: string; full_name: string; organization: string | null }>();

  for (const person of byName) {
    add(person, "same name", 10);
    if (
      entry.organization &&
      person.organization &&
      person.organization.toLowerCase() === entry.organization.toLowerCase()
    ) {
      add(person, "same organization", 5);
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score);
}

export async function promote(ctx: ToolContext, input: PromoteInput): Promise<PromoteResult> {
  const entryId = assertId("re", input.roster_entry_id);
  const entry = await loadEntry(ctx, entryId);

  const wantsLink = input.link_to_person_id !== undefined;
  const wantsNew = input.create_new === true;

  if (wantsLink && wantsNew) {
    throw new ToolError(
      "invalid_input",
      "pass either link_to_person_id or create_new, not both"
    );
  }

  if (!wantsLink && !wantsNew) {
    const { raw_record, ...preview } = entry;
    return {
      status: "candidates",
      roster_entry_id: entryId,
      preview,
      candidates: await findCandidates(ctx, entry),
    };
  }

  const already = await ctx.db
    .prepare("SELECT person_id FROM person_roster_entries WHERE roster_entry_id = ?")
    .bind(entryId)
    .first<{ person_id: string }>();

  if (already) {
    return {
      status: "promoted",
      person: await getPerson(ctx, { person_id: already.person_id }),
      linked_existing: true,
    };
  }

  let personId: string;
  let linkedExisting: boolean;

  if (wantsLink) {
    personId = assertId("p", input.link_to_person_id);
    linkedExisting = true;
  } else {
    const created = await createPerson(ctx, {
      full_name: entry.full_name,
      preferred_name: entry.preferred_name,
      job_title: entry.job_title,
      organization: entry.organization,
    });
    personId = created.id;
    linkedExisting = false;

    if (entry.email) {
      await addContact(ctx, { person_id: personId, contact_type: "email", value: entry.email });
    }
  }

  const at = nowIso(ctx.clock);
  const rawHash = `sha256:${[...new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.raw_record))
  )]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO person_sources
           (id, person_id, source_key, external_row_key, source_url, source_captured_at, raw_record_hash, promoted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (person_id, source_key, external_row_key) DO NOTHING`
      )
      .bind(
        newId("ps"),
        personId,
        entry.source_key,
        entry.external_row_key,
        entry.source_url,
        entry.source_captured_at,
        rawHash,
        at
      ),
    ctx.db
      .prepare(
        `INSERT INTO person_roster_entries (person_id, roster_entry_id, linked_at)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`
      )
      .bind(personId, entryId, at),
  ]);

  return {
    status: "promoted",
    person: await getPerson(ctx, { person_id: personId }),
    linked_existing: linkedExisting,
  };
}
```

Name matching appears here, and only here, as *evidence shown to a human or an agent*. It never selects a person. That distinction is the whole reason `promote` has two phases, and it is why the second phase requires an explicit `link_to_person_id` rather than accepting the top candidate.

- [ ] **Step 4: Modify `getPerson` in `src/tools/people.ts`**

Replace the stubbed `sources`:

```ts
  const { loadPersonSources } = await import("./promote");
  const sources = await loadPersonSources(ctx, id);
```

and return `sources`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/promote.test.ts tests/people.test.ts`
Expected: PASS, all ten promote cases. The purge case is the one that proves durable provenance no longer depends on staged data.

- [ ] **Step 6: Commit**

```bash
git add src/tools/promote.ts src/tools/people.ts tests/promote.test.ts
git commit -m "feat: add two-phase promote with durable provenance copying"
```

---

### Task 14: Roster administration, the tool registry, and contract tests

**Files:**
- Create: `src/tools/roster_admin.ts`, `src/tools/index.ts`
- Test: `tests/roster-admin.test.ts`, `tests/contract.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `function listRosterSources(ctx): Promise<RosterSourceSummary[]>`
  - `function purgeRosterSource(ctx, input): Promise<PurgeResult>`
  - `const TOOLS: Record<string, ToolDefinition>` - the registry plan 2 consumes
  - `interface ToolDefinition { name: string; description: string; destructive: boolean; run(ctx: ToolContext, input: any): Promise<unknown> }`

The registry is the seam between this plan and plan 2. Plan 2's MCP transport iterates `TOOLS` and needs nothing else from this module, which is what keeps the tool layer transport-agnostic.

- [ ] **Step 1: Write the failing test `tests/roster-admin.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { importRoster } from "../src/tools/import";
import { getPerson } from "../src/tools/people";
import { promote } from "../src/tools/promote";
import { listRosterSources, purgeRosterSource } from "../src/tools/roster_admin";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

const SOURCE = {
  source_key: "wcus-2026",
  label: "WCUS 2026",
  event: "WCUS 2026",
  source_url: "https://example.test/attendees",
  format: "json" as const,
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM confirmations").run();
});

describe("listRosterSources", () => {
  it("reports entry counts and how many have been promoted", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    const entry = await env.DB.prepare(
      "SELECT id FROM roster_entries ORDER BY external_row_key LIMIT 1"
    ).first<{ id: string }>();
    await promote(ctx, { roster_entry_id: entry!.id, create_new: true });

    const sources = await listRosterSources(ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual(
      expect.objectContaining({ source_key: "wcus-2026", entry_count: 2, promoted_count: 1 })
    );
  });

  it("returns an empty list when nothing has been imported", async () => {
    expect(await listRosterSources(ctx)).toEqual([]);
  });
});

describe("purgeRosterSource", () => {
  it("previews before deleting and reports what would be lost", async () => {
    await importRoster(ctx, { ...SOURCE, rows: [{ external_row_key: "1", full_name: "Ada" }] });
    const source = await env.DB.prepare("SELECT id FROM roster_sources LIMIT 1").first<{ id: string }>();

    const first = await purgeRosterSource(ctx, { roster_source_id: source!.id });
    expect(first.status).toBe("confirmation_required");
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    expect(first.preview.entry_count).toBe(1);

    const stillThere = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(stillThere?.n).toBe(1);
  });

  it("purges staged rows and leaves promoted people and their provenance", async () => {
    await importRoster(ctx, { ...SOURCE, rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }] });
    const entry = await env.DB.prepare("SELECT id FROM roster_entries LIMIT 1").first<{ id: string }>();
    const promoted = await promote(ctx, { roster_entry_id: entry!.id, create_new: true });
    if (promoted.status !== "promoted") throw new Error("unreachable");

    const source = await env.DB.prepare("SELECT id FROM roster_sources LIMIT 1").first<{ id: string }>();
    const first = await purgeRosterSource(ctx, { roster_source_id: source!.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");
    const done = await purgeRosterSource(ctx, {
      roster_source_id: source!.id,
      confirmation_token: first.confirmation_token,
    });
    expect(done.status).toBe("purged");

    const staged = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
    expect(staged?.n).toBe(0);

    const detail = await getPerson(ctx, { person_id: promoted.person.id });
    expect(detail.full_name).toBe("Ada Lovelace");
    expect(detail.sources).toHaveLength(1);
  });

  it("rejects an unknown source", async () => {
    await expect(
      purgeRosterSource(ctx, { roster_source_id: "rs_00000000-0000-4000-8000-000000000000" })
    ).rejects.toThrow(ToolError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/roster-admin.test.ts`
Expected: FAIL, cannot resolve `../src/tools/roster_admin`.

- [ ] **Step 3: Write `src/tools/roster_admin.ts`**

```ts
import { mintConfirmation, redeemConfirmation } from "../confirm";
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId } from "../ids";

export interface RosterSourceSummary {
  id: string;
  record_kind: "roster_source";
  source_key: string;
  label: string;
  event: string | null;
  entry_count: number;
  promoted_count: number;
  retired_count: number;
  last_imported_at: string | null;
}

export async function listRosterSources(ctx: ToolContext): Promise<RosterSourceSummary[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT rs.id AS id, rs.source_key AS source_key, rs.label AS label, rs.event AS event,
              (SELECT COUNT(*) FROM roster_entries re WHERE re.roster_source_id = rs.id) AS entry_count,
              (SELECT COUNT(*) FROM roster_entries re
                 JOIN person_roster_entries pre ON pre.roster_entry_id = re.id
                WHERE re.roster_source_id = rs.id) AS promoted_count,
              (SELECT COUNT(*) FROM roster_entries re
                WHERE re.roster_source_id = rs.id AND re.retired_at IS NOT NULL) AS retired_count,
              (SELECT MAX(started_at) FROM import_runs ir WHERE ir.roster_source_id = rs.id) AS last_imported_at
       FROM roster_sources rs
       ORDER BY rs.created_at DESC`
    )
    .all<Omit<RosterSourceSummary, "record_kind">>();

  return results.map((row) => ({ record_kind: "roster_source" as const, ...row }));
}

export interface PurgePreview {
  roster_source_id: string;
  source_key: string;
  entry_count: number;
  promoted_count: number;
}

export type PurgeResult =
  | { status: "confirmation_required"; confirmation_token: string; preview: PurgePreview }
  | { status: "purged"; purged: PurgePreview };

export interface PurgeRosterSourceInput {
  roster_source_id: string;
  confirmation_token?: string;
}

async function purgePreview(ctx: ToolContext, id: string): Promise<PurgePreview> {
  const row = await ctx.db
    .prepare(
      `SELECT rs.source_key AS source_key,
              (SELECT COUNT(*) FROM roster_entries re WHERE re.roster_source_id = rs.id) AS entry_count,
              (SELECT COUNT(*) FROM roster_entries re
                 JOIN person_roster_entries pre ON pre.roster_entry_id = re.id
                WHERE re.roster_source_id = rs.id) AS promoted_count
       FROM roster_sources rs WHERE rs.id = ?`
    )
    .bind(id)
    .first<{ source_key: string; entry_count: number; promoted_count: number }>();

  if (!row) throw new ToolError("not_found", `no roster source with id ${id}`);
  return { roster_source_id: id, ...row };
}

export async function purgeRosterSource(
  ctx: ToolContext,
  input: PurgeRosterSourceInput
): Promise<PurgeResult> {
  const id = assertId("rs", input.roster_source_id);

  if (input.confirmation_token === undefined) {
    const preview = await purgePreview(ctx, id);
    const confirmation_token = await mintConfirmation(ctx, "purge_roster_source", id, preview);
    return { status: "confirmation_required", confirmation_token, preview };
  }

  await redeemConfirmation(ctx, "purge_roster_source", id, input.confirmation_token);
  const preview = await purgePreview(ctx, id);
  await ctx.db.prepare("DELETE FROM roster_sources WHERE id = ?").bind(id).run();
  return { status: "purged", purged: preview };
}
```

Deleting the source cascades to `import_runs`, `roster_entries`, and `person_roster_entries`. It does not touch `people` or `person_sources`, because `person_sources` deliberately has no foreign key back to the staged tables. Task 3's fourth test is what proves this.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/roster-admin.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Write `src/tools/index.ts`**

```ts
import type { ToolContext } from "../context";
import { addContact, addLink, removeContact, removeLink, setTags } from "./attributes";
import { deleteEncounter, listEncounters, logEncounter, updateEncounter } from "./encounters";
import { cancelFollowup, completeFollowup, listDue, setFollowup } from "./followups";
import { finalizeImport, importRoster } from "./import";
import {
  archivePerson,
  createPerson,
  deletePerson,
  getPerson,
  unarchivePerson,
  updatePerson,
} from "./people";
import { promote } from "./promote";
import { listRosterSources, purgeRosterSource } from "./roster_admin";
import { searchPeople } from "./search";

export interface ToolDefinition {
  name: string;
  description: string;
  destructive: boolean;
  run(ctx: ToolContext, input: never): Promise<unknown>;
}

function define<I>(
  name: string,
  description: string,
  destructive: boolean,
  run: (ctx: ToolContext, input: I) => Promise<unknown>
): ToolDefinition {
  return { name, description, destructive, run: run as ToolDefinition["run"] };
}

export const TOOLS: Record<string, ToolDefinition> = Object.fromEntries(
  [
    define("search_people", "Search contacts and, on request, staged roster entries.", false, searchPeople),
    define("get_person", "Fetch one person with contacts, tags, provenance, and recent encounters.", false, getPerson),
    define("list_encounters", "List encounters by person, event, or date range.", false, listEncounters),
    define("list_due", "List open follow-ups, most overdue first.", false, listDue),
    define("list_roster_sources", "List imported rosters and how much of each has been promoted.", false, listRosterSources),

    define("create_person", "Create a new person. Never matches on name.", false, createPerson),
    define("update_person", "Update a person by explicit id.", false, updatePerson),
    define("archive_person", "Archive a person without deleting them.", false, archivePerson),
    define("unarchive_person", "Restore an archived person.", false, unarchivePerson),
    define("delete_person", "Permanently delete a person. Two calls: preview, then confirm.", true, deletePerson),

    define("add_contact", "Add an email address or phone number.", false, addContact),
    define("remove_contact", "Remove a contact method.", false, removeContact),
    define("add_link", "Add a website or social profile.", false, addLink),
    define("remove_link", "Remove a link.", false, removeLink),
    define("set_tags", "Replace the whole tag set for a person.", false, setTags),

    define("log_encounter", "Record a conversation. The highest-frequency write.", false, logEncounter),
    define("update_encounter", "Correct a mis-logged encounter.", false, updateEncounter),
    define("delete_encounter", "Delete a mis-logged encounter.", true, deleteEncounter),

    define("set_followup", "Record what is owed to someone and when.", false, setFollowup),
    define("complete_followup", "Close out a follow-up.", false, completeFollowup),
    define("cancel_followup", "Drop a follow-up without completing it.", false, cancelFollowup),

    define("import_roster", "Import roster rows. Resumable: loop until next_cursor is null.", false, importRoster),
    define("finalize_import", "Close an import run and retire rows it did not see.", false, finalizeImport),
    define("promote", "Promote a roster entry to a person. Two calls: candidates, then commit.", false, promote),
    define("purge_roster_source", "Delete a staged roster. Two calls: preview, then confirm.", true, purgeRosterSource),
  ].map((tool) => [tool.name, tool])
);
```

- [ ] **Step 6: Write the failing test `tests/contract.test.ts`**

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { newId } from "../src/ids";
import { TOOLS } from "../src/tools/index";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

describe("tool registry", () => {
  it("exposes every tool the spec names", () => {
    for (const name of [
      "search_people",
      "get_person",
      "list_encounters",
      "list_due",
      "list_roster_sources",
      "create_person",
      "update_person",
      "archive_person",
      "delete_person",
      "add_contact",
      "set_tags",
      "log_encounter",
      "update_encounter",
      "delete_encounter",
      "set_followup",
      "complete_followup",
      "cancel_followup",
      "import_roster",
      "promote",
      "purge_roster_source",
    ]) {
      expect(TOOLS[name], `missing tool ${name}`).toBeDefined();
    }
  });

  it("names every tool consistently with its registry key", () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      expect(tool.name).toBe(key);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("marks exactly the unrecoverable operations destructive", () => {
    const destructive = Object.values(TOOLS)
      .filter((t) => t.destructive)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual(["delete_encounter", "delete_person", "purge_roster_source"]);
  });

  it("rejects a wrong-kind id from every tool that takes one", async () => {
    const wrongKind: [string, Record<string, unknown>][] = [
      ["get_person", { person_id: newId("re") }],
      ["update_person", { person_id: newId("re"), job_title: "x" }],
      ["archive_person", { person_id: newId("enc") }],
      ["log_encounter", { person_id: newId("re"), summary: "x" }],
      ["update_encounter", { encounter_id: newId("p"), summary: "x" }],
      ["set_followup", { person_id: newId("re"), due_on: "2026-08-25" }],
      ["complete_followup", { followup_id: newId("p") }],
      ["promote", { roster_entry_id: newId("p") }],
      ["purge_roster_source", { roster_source_id: newId("p") }],
    ];

    for (const [name, input] of wrongKind) {
      const tool = TOOLS[name]!;
      await expect(tool.run(ctx, input as never), `${name} accepted a wrong-kind id`).rejects.toThrow(
        ToolError
      );
    }
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/contract.test.ts`
Expected: PASS, all four cases. The last one is the plan's single most important test: it proves the id-prefix discipline holds across the whole surface, not just where it was remembered.

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/tools/roster_admin.ts src/tools/index.ts tests/roster-admin.test.ts tests/contract.test.ts
git commit -m "feat: add roster administration and the tool registry"
```

---

## Verification

Run once the fourteen tasks are complete. Nothing here is optional.

- [ ] **Full suite green:** `npm test` passes with no skipped tests.
- [ ] **Types clean:** `npm run typecheck` reports no errors.
- [ ] **Migrations apply to a real local D1, not just the test harness:** `npx wrangler d1 migrations apply junco-prm --local`, then `npx wrangler d1 execute junco-prm --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`. The FTS triggers are the thing being checked; the test harness and Wrangler apply migrations by different code paths, and only the second is what a deployment runs.
- [ ] **No PRM content in logs:** `grep -rn "console\." src/` returns nothing, or only lines carrying tool name, duration, outcome, and identifiers.
- [ ] **Every tool reachable through the registry:** `tests/contract.test.ts` passes.

## What this plan does not build

Named so a reviewer does not read the absence as an oversight.

- No HTTP, no MCP, no OAuth, no `/health`. Plan 2.
- No `export_data` and no restore. Plan 3 builds the CLI export and the tested restore, and the spec is explicit that a tool result is not a backup.
- No merge tool. The spec defers it until there is real duplicate data to design against, and `promote` surfaces candidates without resolving them.
- No rate limiting. It belongs on the unauthenticated OAuth routes, which do not exist until plan 2.
- No scheduled export. It is an open question in the spec, because where the export writes is undecided.
