# Junco PRM Data Layer and Tool Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Junco PRM tool module and its SQLite schema as a pure library over a D1 handle, tested against local D1, with no HTTP transport and no authentication.

**Architecture:** Every PRM operation is a plain async function taking a `ToolContext` (a D1 handle, an owner time zone, and a clock) plus a typed input, returning a typed result. Nothing in this plan knows what MCP or OAuth is. Schema lives in numbered D1 migration files; FTS5 indexes are standalone tables carrying the record's text id as an `UNINDEXED` column, kept in sync by SQLite triggers declared in those migrations, so no application code can forget to update them. A later plan wraps this module in a Worker and an MCP transport; this plan's deliverable is a library plus a test suite that proves it.

**Tech Stack:** TypeScript, Cloudflare Workers runtime (workerd), Cloudflare D1 (SQLite), Wrangler 4.x, Vitest with `@cloudflare/vitest-pool-workers`, Node 26 / npm 11.

**Spec:** `docs/superpowers/specs/2026-08-20-junco-prm-design.md`

**Revised 2026-08-21** after an independent four-agent review of the first draft. Three defects were found by every reviewer that read the plan: the import loop issued one D1 query per row against a 50-query-per-invocation cap, its insert-versus-update counting read `meta.changes` and `meta.last_row_id` in a way SQLite does not support, and `listEncounters` paginated on an id cursor while ordering by date. Those are fixed here. So are a leaked-state bug in Task 3's fixtures, two check-then-act races, a promotion path that was neither atomic nor uniquely constrained, and a registry with no input schemas for plan 2 to advertise. Four decisions were taken during the revision and are recorded in "Decisions taken on review" at the end of this document.

## Scope

This is plan 1 of 3 for spec phase 1.

- **Plan 1 (this document)** - schema, migrations, FTS5, and the full tool module, tested against local D1.
- **Plan 2** - Worker entrypoint, MCP over stateless Streamable HTTP, `workers-oauth-provider`, GitHub as OAuth client, per-request owner authorization, `/health`, fail-closed behavior.
- **Plan 3** - `docs/DEPLOY.md` runbook, `docs/UPGRADE.md`, the deploy template, the CLI durable-data export, and the tested restore.

Plan 1 produces working, testable software on its own: a library whose every function is exercised against a real SQLite database.

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- **Every id is prefixed by kind and validated on input.** `p_` person, `re_` roster entry, `enc_` encounter, `fu_` follow-up, `rs_` roster source, `ir_` import run, `ps_` person source, `pc_` contact method, `pl_` link, `tg_` tag. Passing an id of the wrong kind is a rejected input, never a write.
- **The server never matches a person by name.** Not on create, not on import, not on promote. Names are not identities: the reference roster contains 11 duplicated names across 23 rows.
- **Every write accepts an optional `idempotency_key`.** The same key replayed with the same input returns the original result and writes nothing. This holds for every write without exception, including `deletePerson`'s commit call, `importRoster`, `finalizeImport`, `promote`'s commit call, and `purgeRosterSource`. A confirmation token is not a substitute: a dropped response followed by a client retry presents an already-redeemed token, and without an idempotency record that retry fails instead of replaying its result.
- **Every write returns the full affected record**, so a mistake is visible in the transcript immediately.
- **Destructive operations against a person, a roster source, or bulk staged data are two calls.** The first returns a preview and a `confirmation_token`; the second presents that token. `deletePerson` and `purgeRosterSource` are the two tools this covers. `deleteEncounter` is deliberately outside it and deletes in one call: an encounter is a single row the user just created, `updateEncounter` handles most corrections, and a wrong encounter dictated from a phone should not need a second round trip to erase. D1 Time Travel is the backstop for a delete the user regrets.
- **Import identity is `(roster_source_id, external_row_key)`** under a unique constraint. `external_row_key` comes from the source, or is the SHA-256 of the normalized row when the source has none.
- **Import is resumable across calls,** capped at `IMPORT_BATCH_LIMIT = 150` rows per call. That cap is a server constant, never a caller's choice. Free-plan D1 allows 50 queries per Worker invocation and 100 bound parameters per query, and every statement inside a `db.batch()` counts individually against the query cap. A 150-row call therefore issues roughly 30 queries: one source lookup, one run read or insert, two chunked key pre-checks, 25 multi-row upserts of six rows each, and one run update. Rows per statement, and therefore the query count, are dictated by the 100-parameter cap divided by the column count of `roster_entries`.
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
- `.gitattributes` - forces LF on migration files, which Wrangler's statement splitter is sensitive to.
- `src/index.ts` - stub Worker entrypoint. Plan 2 replaces it.

**Schema**

- `migrations/0001_durable_core.sql` - people, contacts, links, tags.
- `migrations/0002_staged_and_provenance.sql` - roster sources, import runs, roster entries, person sources, person-roster links.
- `migrations/0003_operational.sql` - idempotency keys, confirmation tokens.
- `migrations/0004_search.sql` - FTS5 tables and sync triggers.

**Library**

- `src/errors.ts` - `ToolError` and its codes. One responsibility: how a tool refuses.
- `src/ids.ts` - id minting and prefix validation.
- `src/time.ts` - UTC instants and time-zone-aware local dates.
- `src/types.ts` - the record types shared across tool files and returned by the registry.
- `src/context.ts` - `ToolContext` and the row-to-record mappers shared across tools.
- `src/idempotency.ts` - the replay wrapper.
- `src/confirm.ts` - confirmation-token mint and redeem.
- `src/tools/people.ts` - create, update, archive, hard delete, get.
- `src/tools/attributes.ts` - contacts, links, tags.
- `src/tools/attributes_read.ts` - the loaders `getPerson` composes, kept separate so no module imports its own importer.
- `src/tools/search.ts` - `search_people`.
- `src/tools/encounters.ts` - log, update, delete.
- `src/tools/encounters_read.ts` - list, load, and the keyset cursor helpers.
- `src/tools/followups.ts` - set, complete, cancel, list due.
- `src/tools/followups_read.ts` - the open-follow-up loader.
- `src/tools/import_state.ts` - CSV parsing, row keys, source records, and validated run state.
- `src/tools/import.ts` - the resumable roster import protocol and its finalization.
- `src/tools/promote.ts` - two-phase promotion and provenance copying.
- `src/tools/promote_read.ts` - the person-provenance loader.
- `src/tools/roster_admin.ts` - list sources, purge a source.
- `src/tools/export.ts` - the paginated `export_data` read.
- `src/tools/schema.ts` - the small JSON Schema helpers the registry is built from.
- `src/tools/index.ts` - the registry every later plan consumes, including each tool's input schema.

Files that change together live together: each tool file owns its own SQL, its own input types, and its own record mapping. There is no shared repository layer, because a generic repository over eight tables would be a bigger thing to hold in context than the eight small files it replaced.

**The `_read` suffix is a rule, not a naming accident.** `getPerson` composes six collections, and every module that loads one of them also needs `getPerson` in order to return a full record after a write. That is a cycle in every direction. Each read-only loader therefore lives in a module that imports from `src/types.ts` and nothing else in `src/tools/`, so `people.ts` can import it statically. The first draft solved the same problem with `await import()` inside `getPerson`, which works but hides the dependency, repeats itself in four tasks, and makes every person read do a module resolution.

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
npm install --save-dev --save-exact wrangler@4.125.0 typescript@5 vitest@4.1.11 @cloudflare/vitest-pool-workers@0.22.0 @cloudflare/workers-types@4
mkdir -p migrations
```

Versions are exact, not ranges. A plan written against floating versions is a plan that worked once, and the two packages that matter here move weekly. These were the current releases on 2026-08-21: Wrangler 4.125.0, Vitest 4.1.11, and `@cloudflare/vitest-pool-workers` 0.22.0, which declares a peer dependency on Vitest `^4.1.0`.

Cloudflare has since published `@cloudflare/vitest-plugin` 1.0.0, whose `cloudflareTest()` plus `defineConfig()` shape is what current documentation shows, and an executing agent that searches the docs will find it rather than what is written below. Use what is written below anyway. That package was first published on 2026-08-20 and is one release old; `@cloudflare/vitest-pool-workers` is not deprecated, was updated on 2026-08-18, and targets the same Vitest. Migrating later is a change to one config file. Do not substitute one for the other partway through this plan, because the two configure the same pool through different entry points and a half-migrated harness fails in a way that looks like a database error.

`mkdir -p migrations` is part of this step and not a detail. `readD1Migrations` runs while Vitest evaluates its configuration, before any test executes, and it throws on a missing directory. An empty directory makes the first test fail for the reason the next step claims it fails for.

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

`singleWorker: true` keeps every test file in one worker, running in sequence against one database. Storage would otherwise be isolated per test file, which sounds better and is not: this suite's fixtures clean up with targeted `DELETE` statements in `beforeEach`, and running files in parallel against separate databases hides the case where two tools disagree about state. Sequential is also what makes the end-to-end test in the last task meaningful.

- [ ] **Step 6: Write `tests/apply-migrations.ts`**

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

Migrations are applied once per worker before any test runs. Every test file's `beforeEach` deletes rows; none of them drops tables.

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
Expected: FAIL with `no such table: people`. The `migrations/` directory exists and is empty, so `readD1Migrations` returns an empty list, the harness applies nothing, and the assertion about table names is what fails. If the failure instead comes from Vitest failing to load its configuration, the directory was not created in Step 1 and the test never ran at all.

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

- [ ] **Step 13: Write `.gitattributes`**

```
migrations/*.sql text eol=lf
```

Wrangler splits a migration file into statements before applying it, and Task 5 declares `CREATE TRIGGER ... BEGIN ... END;` bodies that contain internal semicolons. Current Wrangler parses those correctly on LF line endings; there is a confirmed report of trigger migrations failing when the file carries CRLF. Pinning the line ending costs one line and removes the only version of that risk anyone has actually observed. It also has to exist before the first trigger migration is written, not after.

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json tsconfig.json wrangler.jsonc vitest.config.ts env.d.ts .gitattributes src/index.ts migrations/0001_durable_core.sql tests/
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

A local date is read out of `Intl.DateTimeFormat` by parts rather than by string-slicing an ISO instant. Slicing gives the UTC date, which is the bug this module exists to prevent. `formatToParts` is used rather than `format` with the `en-CA` locale: `en-CA` does emit `YYYY-MM-DD` today, but ECMA-402 leaves the exact formatted output partly implementation-defined, and a date module whose correctness rests on a locale's punctuation is a module that breaks on an ICU upgrade. Parts are named, so nothing depends on ordering or separators.

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

  it("rejects a date that matches the shape but does not exist", () => {
    expect(isLocalDate("2026-02-31")).toBe(false);
    expect(isLocalDate("2026-13-01")).toBe(false);
    expect(isLocalDate("2026-00-10")).toBe(false);
    expect(isLocalDate("2026-04-31")).toBe(false);
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
  });
});
```

A regex alone accepts `2026-02-31`, which then reaches `set_followup` as a due date that no calendar will ever produce, sorts between the 30th and the next month, and never appears in `list_due` on the day the user meant. Validating the parsed value is four extra lines here and an unreproducible support question later.

- [ ] **Step 7: Run it to make sure it fails**

Run: `npx vitest run tests/time.test.ts`
Expected: FAIL, cannot resolve `../src/time`.

- [ ] **Step 8: Write `src/time.ts`**

```ts
export function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

export function localDate(timezone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const part = (type: "year" | "month" | "day"): string => {
    const found = parts.find((p) => p.type === type);
    if (found === undefined) {
      throw new Error(`Intl returned no ${type} part for time zone ${timezone}`);
    }
    return found.value;
  };

  return `${part("year")}-${part("month")}-${part("day")}`;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = LOCAL_DATE.exec(value);
  if (match === null) return false;

  const [, year, month, day] = match as unknown as [string, string, string, string];
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return false;

  // Day 0 of month m + 1 is the last day of month m. Months are zero-based here.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= lastDay;
}
```

The destructure is asserted rather than guarded because `noUncheckedIndexedAccess` types every capture group as `string | undefined`, and a successful match of this pattern always has all three. Asserting the tuple once is clearer than three redundant undefined checks, and the regex is a literal two lines above.

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
- Produces: tables `roster_sources`, `import_runs`, `roster_entries`, `person_sources`, `person_roster_entries`, with the unique constraint `(roster_source_id, external_row_key)` that import idempotency depends on, the `expected_total` and `next_offset` columns on `import_runs` that make a resumed import checkable, and a `UNIQUE` on `person_roster_entries.roster_entry_id` so one roster row cannot be promoted onto two people.

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
    "INSERT INTO import_runs (id, roster_source_id, format, input_hash, status, expected_total, next_offset, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind("ir_a", sourceId, "csv", "hash-1", "open", 1, 0, T)
    .run();
  return "ir_a";
}

describe("staged schema", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM roster_entries").run();
    await env.DB.prepare("DELETE FROM import_runs").run();
    await env.DB.prepare("DELETE FROM roster_sources").run();
    await env.DB.prepare("DELETE FROM people").run();
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
      "INSERT INTO import_runs (id, roster_source_id, format, input_hash, status, expected_total, next_offset, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("ir_b", "rs_b", "csv", "hash-2", "open", 1, 0, T)
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

  it("refuses to link one roster entry to two people", async () => {
    const sourceId = await seedSource();
    const runId = await seedRun(sourceId);
    for (const id of ["p_1", "p_2"]) {
      await env.DB.prepare(
        "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
        .bind(id, "Ada Lovelace", T, T)
        .run();
    }
    await env.DB.prepare(
      "INSERT INTO roster_entries (id, roster_source_id, external_row_key, full_name, source_url, source_captured_at, raw_record, last_seen_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind("re_1", sourceId, "row-7", "Ada Lovelace", "https://example.test/a", T, "{}", runId, T, T)
      .run();

    const link = (personId: string) =>
      env.DB.prepare(
        "INSERT INTO person_roster_entries (person_id, roster_entry_id, linked_at) VALUES (?, ?, ?)"
      )
        .bind(personId, "re_1", T)
        .run();

    await link("p_1");
    await expect(link("p_2")).rejects.toThrow();
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
  expected_total   INTEGER NOT NULL,
  next_offset      INTEGER NOT NULL DEFAULT 0,
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
  roster_entry_id TEXT NOT NULL UNIQUE REFERENCES roster_entries(id) ON DELETE CASCADE,
  linked_at       TEXT NOT NULL,
  PRIMARY KEY (person_id, roster_entry_id)
);
```

`person_sources` deliberately has no foreign key to `roster_sources` or `roster_entries`. That absence is the point: durable provenance must survive a purge of the staged data it was copied from.

Two columns in `import_runs` exist for the resumable import protocol in Tasks 12a through 12c and are worth explaining here, where they are created. `expected_total` is the row count the run was opened against, and `next_offset` is how far that run has committed. Together they are what makes a continuation checkable: a second call carrying a `run_id` must present the offset the run actually expects, and `finalizeImport` must refuse a run whose `next_offset` has not reached `expected_total`. Without them a caller can skip rows by advancing the cursor and then finalize with full coverage, which retires valid entries that were never seen.

The `UNIQUE` on `person_roster_entries.roster_entry_id` is not redundant with the composite primary key. The primary key alone permits one roster row to be linked to two different people, which is the wrong direction of the many-to-many: one person may appear on many rosters, but one roster row is one human and belongs to at most one person record.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/staged-schema.test.ts`
Expected: PASS, all five cases. The last is the one that matters most; it proves purging a source leaves the promoted person's provenance intact.

The `beforeEach` deletes `people` as well as the staged tables. Deleting the source cascades to its runs and entries, but people are durable and survive it, and two cases in this file both insert `p_1`. Without that fourth delete the second one fails on a primary-key violation rather than on the behavior it is testing.

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
  response_json TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
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

`response_json` is nullable because the row is written twice: once to claim the key before the operation runs, and once to record the result after it succeeds. A row with a null `response_json` means "this key is in flight," which is the state that makes the claim useful. Without it, two calls carrying the same key can both read "no such key" and both perform the write, which is the exact duplicate the key exists to prevent.

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

  it("refuses a second call while the first holding that key is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn().mockImplementation(async () => {
      await gate;
      return { id: "enc_1" };
    });

    const first = withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run);
    await expect(
      withIdempotency(ctx, "log_encounter", "k1", { x: 1 }, run)
    ).rejects.toThrow(ToolError);

    release();
    await expect(first).resolves.toEqual({ id: "enc_1" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

The last case is the one that justifies the claim row. Both calls carry the same key, and the first has not finished, so a read-then-write implementation lets both through and writes the encounter twice. Refusing the second is the correct answer rather than making it wait: the caller is a retrying client, the original call is still going to return, and a tool that blocks on another request's completion is a tool that ties up a Worker invocation waiting on itself.

Do not weaken this test into "either behavior is fine." The two calls resume in the order they suspended, so the first claim insert always precedes the second, and the assertion is deterministic.

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
  const at = nowIso(ctx.clock);

  // Claim the key first. The insert is the lock: whichever caller wins it runs the
  // operation, and everyone else sees the claim rather than an empty table.
  const claim = await ctx.db
    .prepare(
      `INSERT INTO idempotency_keys (key, tool, request_hash, response_json, created_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (key) DO NOTHING`
    )
    .bind(scoped, tool, requestHash, at)
    .run();

  if (claim.meta.changes === 0) {
    const existing = await ctx.db
      .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?")
      .bind(scoped)
      .first<{ request_hash: string; response_json: string | null }>();

    if (!existing) {
      throw new ToolError("conflict", `idempotency_key "${key}" is contended; retry`);
    }
    if (existing.request_hash !== requestHash) {
      throw new ToolError(
        "conflict",
        `idempotency_key "${key}" was already used by ${tool} with different arguments`
      );
    }
    if (existing.response_json === null) {
      throw new ToolError(
        "conflict",
        `idempotency_key "${key}" is still in flight for ${tool}; retry once the first call returns`
      );
    }
    return JSON.parse(existing.response_json) as T;
  }

  let result: T;
  try {
    result = await run();
  } catch (error) {
    // Release the claim so a corrected retry with the same key is possible.
    await ctx.db.prepare("DELETE FROM idempotency_keys WHERE key = ?").bind(scoped).run();
    throw error;
  }

  await ctx.db
    .prepare("UPDATE idempotency_keys SET response_json = ?, completed_at = ? WHERE key = ?")
    .bind(JSON.stringify(result), nowIso(ctx.clock), scoped)
    .run();

  return result;
}
```

Three D1 queries on the common path, four when a key is replayed. That matters for `importRoster`, which wraps a call that is already close to the per-invocation query budget, and it is why `IMPORT_BATCH_LIMIT` is set with margin rather than at the arithmetic maximum.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/idempotency.test.ts`
Expected: PASS, all eight cases.

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

  const at = nowIso(ctx.clock);

  // One conditional UPDATE performs every check. Reading the row first and updating
  // second lets two calls both pass the read and both redeem the same token.
  const redeemed = await ctx.db
    .prepare(
      `UPDATE confirmations
          SET redeemed_at = ?
        WHERE token = ?
          AND action = ?
          AND target_id = ?
          AND redeemed_at IS NULL
          AND expires_at > ?`
    )
    .bind(at, token, action, targetId, at)
    .run();

  if (redeemed.meta.changes === 1) return;

  // The update matched nothing. Read the row only to say why, never to decide.
  const row = await ctx.db
    .prepare("SELECT action, target_id, expires_at, redeemed_at FROM confirmations WHERE token = ?")
    .bind(token)
    .first<{ action: string; target_id: string; expires_at: string; redeemed_at: string | null }>();

  if (!row) throw new ToolError("confirmation_invalid", "unknown confirmation_token");
  if (row.redeemed_at) throw new ToolError("confirmation_invalid", "confirmation_token already used");
  if (row.action !== action || row.target_id !== targetId) {
    throw new ToolError("confirmation_invalid", "confirmation_token does not match this operation");
  }
  throw new ToolError("confirmation_invalid", "confirmation_token expired");
}
```

The comparison `expires_at > ?` works as a string comparison because both sides are UTC ISO-8601 instants with the same fixed width, which sort lexicographically in time order. That is a property of the format this codebase stores, not of SQLite, so it holds only as long as `nowIso` keeps producing `toISOString()` output.

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
- Produces: `people_fts`, an FTS5 table carrying `people.id` as an `UNINDEXED` column, kept in sync by three triggers.

**Why this is not an external-content table.** The obvious shape is `content='people', content_rowid='rowid'`, which stores the text once and lets FTS read columns back through the source table. It is rejected here. `people.id` is `TEXT PRIMARY KEY`, so the table has no explicit `INTEGER PRIMARY KEY` and its rowid is the implicit one SQLite assigns, and SQLite documents that `VACUUM` may renumber rowids in exactly that case. If that ever happens under D1, every entry in the index points at the wrong person and nothing raises an error: search silently returns other people's records. The alternative fix, adding an integer surrogate key to `people` and `encounters` purely to stabilize the rowid, buys back the storage at the cost of a second key on every durable row and a second thing every insert path has to be right about.

Carrying `id` as an `UNINDEXED` column stores the searchable text a second time. At this scale that is a few megabytes against a 500 MB database limit, and it removes the rowid dependency completely rather than betting on D1's maintenance behavior.

**Known risk this task exists to retire:** D1 migration files are split into statements by Wrangler before execution. A `CREATE TRIGGER ... BEGIN ... END;` body contains internal semicolons. Current Wrangler parses those correctly, and the one confirmed failure report involves CRLF line endings, which `.gitattributes` from Task 1 already prevents. The test below fails loudly if a trigger is half-applied anyway, which is why trigger sync is tested rather than assumed. If the migration genuinely cannot be applied as one file, split the triggers into their own migration file. Do not fall back to creating schema from application code: a Worker that builds its own indexes at startup has no single answer to what the schema version is, and `/health` in plan 2 reports exactly that. Do not proceed past this task with untested triggers.

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
     JOIN people p ON p.id = f.id
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
    await insertPerson("p_2", "Ordinary Row", "Kinsta", null);
    // Quoted, those words are a phrase to match, not operators to evaluate.
    expect(await search(`"NOT AND OR"`)).toEqual(["p_1"]);
  });
});
```

The last case asserts the row it finds, not merely that the query returned something. `resolves.toBeDefined()` passes against an implementation that matches nothing, which is the failure this case exists to detect.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/search-index.test.ts`
Expected: FAIL, no such table `people_fts`.

- [ ] **Step 3: Write `migrations/0004_search.sql`**

```sql
CREATE VIRTUAL TABLE people_fts USING fts5(
  id UNINDEXED,
  full_name,
  preferred_name,
  organization,
  job_title,
  notes
);

CREATE TRIGGER people_fts_ai AFTER INSERT ON people BEGIN
  INSERT INTO people_fts (id, full_name, preferred_name, organization, job_title, notes)
  VALUES (new.id, new.full_name, new.preferred_name, new.organization, new.job_title, new.notes);
END;

CREATE TRIGGER people_fts_ad AFTER DELETE ON people BEGIN
  DELETE FROM people_fts WHERE id = old.id;
END;

CREATE TRIGGER people_fts_au AFTER UPDATE ON people BEGIN
  DELETE FROM people_fts WHERE id = old.id;
  INSERT INTO people_fts (id, full_name, preferred_name, organization, job_title, notes)
  VALUES (new.id, new.full_name, new.preferred_name, new.organization, new.job_title, new.notes);
END;
```

The delete and update triggers use ordinary `DELETE FROM ... WHERE id = ...` rather than the `INSERT INTO people_fts (people_fts, rowid, ...) VALUES ('delete', ...)` command form. That command form exists to tell an external-content index which row to forget, since it cannot read the deleted row itself. This table owns its own content, so a plain delete is both correct and considerably harder to get subtly wrong.

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
- Create: `src/types.ts`, `src/tools/people.ts`
- Test: `tests/people.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `ToolError`, `newId`, `assertId`, `nowIso`, `withIdempotency`.
- Produces:
  - `src/types.ts`, holding every record type the tool module returns: `Person`, `PersonDetail`, `Contact`, `Link`, `Source`, `Encounter`, `Followup`.
  - `function createPerson(ctx, input): Promise<Person>`
  - `function updatePerson(ctx, input): Promise<Person>`
  - `function getPerson(ctx, input): Promise<PersonDetail>`

Task 7 fills `contacts`, `links`, `tags`; Task 10 fills `recent_encounters`, `encounter_count`, and `encounter_next_cursor`; Task 11 fills `open_followups`; Task 13 fills `sources`. Until then those fields return empty arrays, zero, and null, and the tests below assert exactly that so the shape is pinned from the start.

**Why the types are declared here, in one file, for tables that do not exist yet.** The first draft declared `PersonDetail` with `unknown[]` collections and expected later tasks to narrow them. They never do: `Contact[]` is assignable to `unknown[]`, so every later task compiles without touching the interface, and every caller of `getPerson` receives untyped arrays it has to cast. A cast in a test is the visible symptom; the real cost is that plan 2 cannot generate an output schema from a type that says `unknown`. Declaring all seven record types up front costs nothing at runtime, since types are erased, and it means each later task adds a query rather than renegotiating a shape.

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
    expect(detail.encounter_next_cursor).toBeNull();
  });

  it("rejects an id of the wrong kind", async () => {
    await expect(getPerson(ctx, { person_id: newId("enc") })).rejects.toThrow(ToolError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/people.test.ts`
Expected: FAIL, cannot resolve `../src/tools/people`.

- [ ] **Step 3: Write `src/types.ts`**

```ts
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

export interface Source {
  id: string;
  source_key: string;
  external_row_key: string;
  source_url: string;
  source_captured_at: string;
  promoted_at: string;
}

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

export interface Followup {
  id: string;
  record_kind: "followup";
  person_id: string;
  due_on: string;
  note: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface PersonDetail extends Person {
  contacts: Contact[];
  links: Link[];
  tags: string[];
  sources: Source[];
  open_followups: Followup[];
  recent_encounters: Encounter[];
  encounter_count: number;
  encounter_next_cursor: string | null;
}
```

This file holds types only. It imports nothing and is imported by everything, so it cannot participate in an import cycle.

- [ ] **Step 4: Write `src/tools/people.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import type { Person, PersonDetail } from "../types";

export type { Person, PersonDetail } from "../types";

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
    encounter_next_cursor: null,
  };
}
```

`getPerson` is the one function four later tasks all modify, and each of them adds two lines to the same object literal. Those tasks state their change as a diff against this body rather than reprinting the function, because an agent that sees only its own task and a full replacement body will drop whatever the previous three added. This body is the base they diff against.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/people.test.ts`
Expected: PASS, all ten cases.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tools/people.ts tests/people.test.ts
git commit -m "feat: add create, update, and get for people"
```

---

### Task 7: Contacts, links, and tags

**Files:**
- Create: `src/tools/attributes_read.ts`, `src/tools/attributes.ts`
- Modify: `src/tools/people.ts` - `getPerson` now loads real collections
- Test: `tests/attributes.test.ts`

**Interfaces:**
- Consumes: `loadPerson`, `assertId`, `withIdempotency`, the `Contact` and `Link` types from `src/types.ts`.
- Produces:
  - `function loadContacts(ctx, personId): Promise<Contact[]>`, `loadLinks`, `loadTags`, all in `src/tools/attributes_read.ts`
  - `function addContact(ctx, input): Promise<PersonDetail>`
  - `function removeContact(ctx, input): Promise<PersonDetail>`
  - `function addLink(ctx, input): Promise<PersonDetail>`
  - `function removeLink(ctx, input): Promise<PersonDetail>`
  - `function setTags(ctx, input): Promise<PersonDetail>`

Every one of these returns the full `PersonDetail` rather than the row it touched, per the global constraint that a write shows the whole affected record.

**Why the loaders live in their own file.** `people.ts` needs the loaders and `attributes.ts` needs `getPerson`, which is a cycle. The first draft broke it with a dynamic `import()` inside `getPerson`. That works, but it hides a real dependency behind a runtime call, it makes every read of a person do a module resolution, and the same trick then has to be repeated in Tasks 10, 11, and 13 until `getPerson` is four dynamic imports deep. Putting the read-only loaders in `attributes_read.ts`, which imports nothing from either file, removes the cycle instead of deferring it. Every later task follows the same rule: read loaders go in a `_read` module, writers import both.

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
    const first = added.contacts[0];
    if (first === undefined) throw new Error("addContact returned no contact");
    const contactId = first.id;
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

- [ ] **Step 3: Write `src/tools/attributes_read.ts`**

```ts
import type { ToolContext } from "../context";
import type { Contact, Link } from "../types";

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
```

- [ ] **Step 4: Write `src/tools/attributes.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import type { PersonDetail } from "../types";
import { getPerson, loadPerson } from "./people";

export type { Contact, Link } from "../types";

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

- [ ] **Step 5: Modify `getPerson` in `src/tools/people.ts` to load the real collections**

This is a diff against the body written in Task 6, not a replacement. Three later tasks change the same function, so change only the lines named here and leave everything else in place.

Add to the imports at the top of `people.ts`:

```ts
import { loadContacts, loadLinks, loadTags } from "./attributes_read";
```

Inside `getPerson`, after `const person = await loadPerson(ctx, id);`, add:

```ts
  const [contacts, links, tags] = await Promise.all([
    loadContacts(ctx, id),
    loadLinks(ctx, id),
    loadTags(ctx, id),
  ]);
```

Then in the returned object literal, replace these three lines:

```ts
    contacts: [],
    links: [],
    tags: [],
```

with:

```ts
    contacts,
    links,
    tags,
```

`sources`, `open_followups`, `recent_encounters`, `encounter_count`, and `encounter_next_cursor` keep their placeholder values. Later tasks replace those the same way.

The import is static because `attributes_read.ts` imports nothing from `people.ts`. Do not import from `./attributes` here; that file imports `getPerson` and the cycle comes straight back.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/attributes.test.ts tests/people.test.ts`
Expected: PASS. The `getPerson` stub assertions in `tests/people.test.ts` still pass because a person with no attributes still has empty collections.

- [ ] **Step 7: Commit**

```bash
git add src/tools/attributes_read.ts src/tools/attributes.ts src/tools/people.ts tests/attributes.test.ts
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

  it("replays a confirmed delete that the client retried", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const first = await deletePerson(ctx, { person_id: person.id });
    if (first.status !== "confirmation_required") throw new Error("unreachable");

    const args = {
      person_id: person.id,
      confirmation_token: first.confirmation_token,
      idempotency_key: "k1",
    };
    const committed = await deletePerson(ctx, args);
    // The client never saw the response and sent the same call again.
    const retried = await deletePerson(ctx, args);

    expect(retried).toEqual(committed);
    expect(retried.status).toBe("deleted");
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
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_encounters_person ON encounters(person_id, occurred_on DESC, id);
CREATE INDEX idx_encounters_event ON encounters(event);

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

The first draft gave `encounters` a nullable `deleted_at` and an index over it, and then deleted encounters with `DELETE FROM`. Nothing ever wrote the column or read it, and a column that no code touches is a column the next person assumes is meaningful. It is dropped. Deleting an encounter is a hard delete by design, because the point is to erase a mistake rather than to keep a record of one, and Time Travel is what recovers a delete the user regrets. If soft delete is ever wanted, it arrives as a migration with tools that use it.

`idx_encounters_person` carries `id` as a third column so it covers the exact sort `listEncounters` pages on, which is `occurred_on DESC, id ASC`.

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
  idempotency_key?: string;
}

async function deletePreview(ctx: ToolContext, id: string): Promise<DeletePreview> {
  const person = await loadPerson(ctx, id);
  const counts = await ctx.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM person_contacts WHERE person_id = ?1) AS contacts,
         (SELECT COUNT(*) FROM encounters WHERE person_id = ?1) AS encounters,
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

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "delete_person", idempotency_key, rest, async () => {
    await redeemConfirmation(ctx, "delete_person", id, input.confirmation_token);
    const preview = await deletePreview(ctx, id);
    await ctx.db.prepare("DELETE FROM people WHERE id = ?").bind(id).run();
    return { status: "deleted", deleted: preview };
  });
}
```

Only the commit call is wrapped. Minting a preview writes a confirmation row and nothing else, and replaying a preview should hand back a fresh token rather than a stale one that may already be redeemed or expired.

The commit call is where an idempotency key matters most in the whole module. Without it, a client that sends the confirmed delete, loses the response, and retries presents a token that was already redeemed, so the retry fails with `confirmation_invalid` even though the person is gone. The caller then cannot tell a successful delete it did not see from a delete that never happened. With the key, the retry replays the original result.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/people-lifecycle.test.ts`
Expected: PASS, all seven cases. The cascade case is the one that proves the foreign keys from Task 1 are doing real work, and the retry case is the one that proves a lost response cannot strand the caller.

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

  it("finds a person by a tag that appears nowhere in their text", async () => {
    const person = await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    await setTags(ctx, { person_id: person.id, tags: ["wcus"] });
    const out = await searchPeople(ctx, { query: "wcus" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.id).toBe(person.id);
  });

  it("ranks a text match above a tag-only match", async () => {
    const tagged = await createPerson(ctx, { full_name: "Ada Lovelace" });
    await setTags(ctx, { person_id: tagged.id, tags: ["kinsta"] });
    await createPerson(ctx, { full_name: "Grace Hopper", organization: "Kinsta" });

    const out = await searchPeople(ctx, { query: "Kinsta" });
    expect(out.results.map((r) => r.full_name)).toEqual(["Grace Hopper", "Ada Lovelace"]);
  });

  it("treats LIKE wildcards in a roster query as literal characters", async () => {
    await seedRoster();
    const out = await searchPeople(ctx, { query: "%", scope: "roster" });
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

/**
 * Escapes the LIKE metacharacters so a query containing % or _ matches those
 * characters literally instead of behaving as a wildcard. Pairs with ESCAPE
 * in every LIKE clause below.
 */
export function likePattern(raw: string): string {
  return `%${raw.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
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
      `WITH text_hits AS (
         SELECT f.id AS id, bm25(people_fts) AS rank
         FROM people_fts f
         WHERE people_fts MATCH ?1
       ),
       tag_hits AS (
         SELECT pt.person_id AS id, 1000.0 AS rank
         FROM person_tags pt
         JOIN tags t ON t.id = pt.tag_id
         WHERE t.name LIKE ?4 ESCAPE '\\'
       ),
       hits AS (
         SELECT id, MIN(rank) AS rank
         FROM (SELECT id, rank FROM text_hits UNION ALL SELECT id, rank FROM tag_hits)
         GROUP BY id
       )
       SELECT p.id AS id, p.full_name AS full_name, p.organization AS organization,
              p.job_title AS job_title, p.archived_at AS archived_at,
              (SELECT MAX(occurred_on) FROM encounters e
                WHERE e.person_id = p.id) AS last_encounter_on,
              (SELECT group_concat(t.name, char(31)) FROM person_tags pt
                 JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = p.id) AS tag_blob
       FROM hits
       JOIN people p ON p.id = hits.id
       WHERE (?2 = 1 OR p.archived_at IS NULL)
       ORDER BY hits.rank
       LIMIT ?3`
    )
    .bind(match, input.include_archived ? 1 : 0, probe, likePattern(input.query))
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
    const like = likePattern(input.query);
    const { results: rows } = await ctx.db
      .prepare(
        `SELECT re.id AS id, re.full_name AS full_name, re.organization AS organization,
                re.job_title AS job_title, rs.source_key AS source_key,
                (SELECT person_id FROM person_roster_entries pre
                  WHERE pre.roster_entry_id = re.id LIMIT 1) AS promoted_person_id
         FROM roster_entries re
         JOIN roster_sources rs ON rs.id = re.roster_source_id
         WHERE re.retired_at IS NULL
           AND (re.full_name LIKE ?1 ESCAPE '\\'
             OR re.organization LIKE ?1 ESCAPE '\\'
             OR re.job_title LIKE ?1 ESCAPE '\\')
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

**Tags participate in matching, not only in display.** The spec lists tags among the fields `search_people` searches. The first draft only loaded them for the result payload, so `search_people("wcus")` found nobody unless the word also appeared in a name, an organization, a title, or a note. They cannot simply be added to `people_fts`, because tag membership changes without `people` being updated and no trigger on `people` would fire. The `tag_hits` branch searches `tags` directly and unions the two sets of person ids.

Ranking works because `bm25()` returns negative scores where a better match is more negative, so ordering ascending puts real text matches first and the fixed `1000.0` given to tag hits sorts them after. That is the intended precedence: someone whose notes mention WordCamp is a better answer than someone merely tagged `wcus`, and both belong in the result.

**Every `LIKE` escapes its metacharacters.** Without `likePattern` and the `ESCAPE` clause, a query containing `%` matches every row and one containing `_` matches any single character. Roster text comes from strangers and queries come from an agent relaying a user, so neither is trusted to be free of them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/search.test.ts`
Expected: PASS, all thirteen cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search.ts tests/search.test.ts
git commit -m "feat: add search_people with explicit scope and record_kind"
```

---

### Task 10: Encounters

**Files:**
- Create: `src/tools/encounters_read.ts`, `src/tools/encounters.ts`, `migrations/0006_encounters_search.sql`
- Modify: `src/tools/people.ts` - `getPerson` returns real `recent_encounters`, `encounter_count`, and `encounter_next_cursor`
- Test: `tests/encounters.test.ts`

**Interfaces:**
- Consumes: the `encounters` table from Task 8, the `Encounter` type from `src/types.ts`, `localDate`, `isLocalDate`, `withIdempotency`.
- Produces:
  - `function logEncounter(ctx, input): Promise<{ encounter: Encounter; person: PersonDetail }>`
  - `function updateEncounter(ctx, input): Promise<Encounter>`
  - `function deleteEncounter(ctx, input): Promise<{ status: "deleted"; deleted: Encounter }>`
  - `function listEncounters(ctx, input): Promise<{ results: Encounter[]; next_cursor: string | null }>` - keyset paginated on `(occurred_on, id)`
  - `function loadRecentEncounters(ctx, personId, limit, cursor?): Promise<{ results: Encounter[]; total: number; next_cursor: string | null }>`

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

  it("walks every page without skipping or repeating a row", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    for (let i = 1; i <= 5; i++) {
      await logEncounter(ctx, {
        person_id: person.id,
        summary: `n${i}`,
        occurred_on: `2026-08-0${i}`,
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listEncounters(ctx, { person_id: person.id, limit: 2, cursor });
      seen.push(...page.results.map((e) => e.summary));
      cursor = page.next_cursor ?? undefined;
      pages++;
      if (pages > 10) throw new Error("pagination did not terminate");
    } while (cursor !== undefined);

    // Newest first, every row exactly once.
    expect(seen).toEqual(["n5", "n4", "n3", "n2", "n1"]);
  });

  it("paginates correctly when several encounters share one date", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    for (let i = 1; i <= 4; i++) {
      await logEncounter(ctx, {
        person_id: person.id,
        summary: `same${i}`,
        occurred_on: "2026-08-01",
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listEncounters(ctx, { person_id: person.id, limit: 2, cursor });
      seen.push(...page.results.map((e) => e.summary));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });
});
```

Both cases walk the whole result set rather than comparing two pages. The first draft asserted only that page one and page two shared no ids, which an implementation that silently skips rows also satisfies. The second case is the one that fails against an id-only cursor: four encounters on one date have no date ordering between them, so the tiebreaker is all that keeps the walk correct.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/encounters.test.ts`
Expected: FAIL, cannot resolve `../src/tools/encounters`.

- [ ] **Step 3: Write `migrations/0006_encounters_search.sql`**

```sql
CREATE VIRTUAL TABLE encounters_fts USING fts5(
  id UNINDEXED,
  summary,
  location,
  event
);

CREATE TRIGGER encounters_fts_ai AFTER INSERT ON encounters BEGIN
  INSERT INTO encounters_fts (id, summary, location, event)
  VALUES (new.id, new.summary, new.location, new.event);
END;

CREATE TRIGGER encounters_fts_ad AFTER DELETE ON encounters BEGIN
  DELETE FROM encounters_fts WHERE id = old.id;
END;

CREATE TRIGGER encounters_fts_au AFTER UPDATE ON encounters BEGIN
  DELETE FROM encounters_fts WHERE id = old.id;
  INSERT INTO encounters_fts (id, summary, location, event)
  VALUES (new.id, new.summary, new.location, new.event);
END;
```

Same shape as `people_fts` in Task 5, and for the same reason: `encounters.id` is `TEXT PRIMARY KEY`, so the table's rowid is the implicit one, and an external-content index keyed on it can be silently detached by a `VACUUM`. Carrying the text id as an `UNINDEXED` column costs a second copy of the summary text and removes the dependency.

Two FTS indexes rather than one, per the spec: people and encounters are different entities, and conflating them produces a ranked list an agent cannot explain.

- [ ] **Step 4: Write `src/tools/encounters_read.ts`**

The reads go in their own module for the reason given in Task 7: `people.ts` needs `loadRecentEncounters` and `encounters.ts` needs `getPerson`, and a module that only reads breaks that cycle without a dynamic import. The row mapper, the column list, and the cursor helpers live here too, and the writer module in the next step imports them.

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId } from "../ids";
import { isLocalDate } from "../time";
import type { Encounter } from "../types";

export type { Encounter } from "../types";

export interface EncounterRow {
  id: string;
  person_id: string;
  occurred_on: string;
  occurred_at: string | null;
  location: string | null;
  event: string | null;
  summary: string;
  created_at: string;
}

export const COLUMNS =
  "id, person_id, occurred_on, occurred_at, location, event, summary, created_at";

export function toEncounter(row: EncounterRow): Encounter {
  return { record_kind: "encounter", ...row };
}

function encodeCursor(encounter: Encounter): string {
  return `${encounter.occurred_on}|${encounter.id}`;
}

function decodeCursor(cursor: unknown): { occurred_on: string; id: string } {
  if (typeof cursor !== "string") {
    throw new ToolError("invalid_input", "cursor must be a string from a previous next_cursor");
  }
  const [occurred_on, id] = cursor.split("|");
  if (occurred_on === undefined || id === undefined || !isLocalDate(occurred_on)) {
    throw new ToolError("invalid_input", "cursor is malformed; pass back next_cursor unchanged");
  }
  return { occurred_on, id: assertId("enc", id) };
}

export async function loadEncounter(ctx: ToolContext, id: string): Promise<Encounter> {
  const row = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM encounters WHERE id = ?`)
    .bind(id)
    .first<EncounterRow>();
  if (!row) throw new ToolError("not_found", `no encounter with id ${id}`);
  return toEncounter(row);
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
  const clauses: string[] = [];
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
    const { occurred_on, id } = decodeCursor(input.cursor);
    // Keyset on the full sort key: strictly older dates, or the same date further
    // along in id order.
    clauses.push("(occurred_on < ? OR (occurred_on = ? AND id > ?))");
    values.push(occurred_on, occurred_on, id);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM encounters
       ${where}
       ORDER BY occurred_on DESC, id ASC
       LIMIT ?`
    )
    .bind(...values, limit + 1)
    .all<EncounterRow>();

  const page = results.slice(0, limit).map(toEncounter);
  const last = page[page.length - 1];
  const next = results.length > limit && last !== undefined ? encodeCursor(last) : null;
  return { results: page, next_cursor: next };
}

export async function loadRecentEncounters(
  ctx: ToolContext,
  personId: string,
  limit: number,
  cursor?: string
): Promise<{ results: Encounter[]; total: number; next_cursor: string | null }> {
  const page = await listEncounters(ctx, { person_id: personId, limit, cursor });

  const count = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM encounters WHERE person_id = ?")
    .bind(personId)
    .first<{ n: number }>();

  return { ...page, total: count?.n ?? 0 };
}
```

**The cursor has to carry the whole sort key.** The first draft ordered by `occurred_on DESC, id ASC` and then paginated with `id > cursor`. Ids are UUID-derived, so their order has no relationship to date order: page two drops encounters whose id happens to sort below the cursor and repeats ones that sort above it. The pagination test in this task has to assert more than "no ids overlap" for the same reason, because an implementation that skips rows produces pages that do not overlap either. It asserts that walking every page returns exactly the seeded set, in the seeded order.

`loadRecentEncounters` delegates to `listEncounters` rather than running its own query. The first draft had two queries over the same table with two different sort orders, `id DESC` here against `id ASC` there, so a cursor produced by one was meaningless to the other. One ordering, defined once, and `getPerson` can now page through a long history instead of silently truncating at its limit.

- [ ] **Step 5: Write `src/tools/encounters.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { isLocalDate, localDate, nowIso } from "../time";
import type { Encounter, PersonDetail } from "../types";
import { loadEncounter } from "./encounters_read";
import { getPerson, loadPerson } from "./people";

export type { Encounter } from "../types";
export {
  listEncounters,
  loadEncounter,
  loadRecentEncounters,
  type ListEncountersInput,
} from "./encounters_read";

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
      .prepare(`UPDATE encounters SET ${sets.join(", ")} WHERE id = ?`)
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
```

`deleteEncounter` is the module's one destructive operation that takes no confirmation token, which is a deliberate exception to the global two-call rule and is written down as one in Global Constraints. It still takes an `idempotency_key`, so a retried delete replays rather than returning `not_found` for a row it removed itself.

The re-exports at the top mean callers, tests, and the registry can all import every encounter function from `./encounters` without caring which of the two files it lives in. `people.ts` is the exception and imports `./encounters_read` directly, because importing `./encounters` would recreate the cycle.

- [ ] **Step 6: Modify `getPerson` in `src/tools/people.ts`**

A diff against the current body, not a replacement. Task 7 already added the contact, link, and tag lines; leave them alone.

Add to the imports at the top of `people.ts`:

```ts
import { loadRecentEncounters } from "./encounters_read";
```

Inside `getPerson`, after the `Promise.all` that loads contacts, links, and tags, add:

```ts
  const encounters = await loadRecentEncounters(
    ctx,
    id,
    input.encounter_limit ?? 10,
    input.encounter_cursor
  );
```

Then replace these three lines of the returned object literal:

```ts
    recent_encounters: [],
    encounter_count: 0,
    encounter_next_cursor: null,
```

with:

```ts
    recent_encounters: encounters.results,
    encounter_count: encounters.total,
    encounter_next_cursor: encounters.next_cursor,
```

`sources` and `open_followups` keep their placeholders until Tasks 11 and 13.

`GetPersonInput` has declared `encounter_cursor` since Task 6 and nothing read it, so a caller could pass one and silently get page one back forever. Passing it through is the whole fix, and `encounter_next_cursor` on the result is what makes the field usable at all: without it the caller has no cursor to send.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/encounters.test.ts tests/people.test.ts tests/people-lifecycle.test.ts`
Expected: PASS. `tests/people.test.ts` still passes because a person with no encounters has an empty list, a count of zero, and a null cursor.

- [ ] **Step 8: Commit**

```bash
git add src/tools/encounters_read.ts src/tools/encounters.ts migrations/0006_encounters_search.sql src/tools/people.ts tests/encounters.test.ts
git commit -m "feat: add encounter logging, correction, deletion, and listing"
```

---

### Task 11: Follow-ups and `list_due`

**Files:**
- Create: `src/tools/followups_read.ts`, `src/tools/followups.ts`
- Modify: `src/tools/people.ts` - `getPerson` returns real `open_followups`
- Test: `tests/followups.test.ts`

**Interfaces:**
- Consumes: the `followups` table from Task 8, the `Followup` type from `src/types.ts`, `localDate`, `isLocalDate`.
- Produces:
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

- [ ] **Step 3: Write `src/tools/followups_read.ts`**

Same split as Tasks 7 and 10: `loadOpenFollowups` is what `getPerson` needs, and putting it in a module that imports nothing from `people.ts` is what keeps the import graph acyclic.

```ts
import type { ToolContext } from "../context";
import type { Followup } from "../types";

export type { Followup } from "../types";

const COLUMNS = "id, person_id, due_on, note, completed_at, cancelled_at";

export function toFollowup(row: Omit<Followup, "record_kind">): Followup {
  return { record_kind: "followup", ...row };
}

export async function loadOpenFollowups(ctx: ToolContext, personId: string): Promise<Followup[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT ${COLUMNS} FROM followups
       WHERE person_id = ? AND completed_at IS NULL AND cancelled_at IS NULL
       ORDER BY due_on, id`
    )
    .bind(personId)
    .all<Omit<Followup, "record_kind">>();
  return results.map(toFollowup);
}
```

- [ ] **Step 4: Write `src/tools/followups.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { isLocalDate, localDate, nowIso } from "../time";
import type { Followup, PersonDetail } from "../types";
import { loadOpenFollowups, toFollowup } from "./followups_read";
import { getPerson, loadPerson } from "./people";

export type { Followup } from "../types";
export { loadOpenFollowups } from "./followups_read";

export interface DueItem extends Followup {
  person_name: string;
  days_overdue: number;
}

type FollowupRow = Omit<Followup, "record_kind">;

const COLUMNS = "id, person_id, due_on, note, completed_at, cancelled_at";
const OPEN = "completed_at IS NULL AND cancelled_at IS NULL";

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

```

`loadOpenFollowups` and `toFollowup` are not repeated here; they live in `followups_read.ts` and are re-exported at the top of this file so callers and the registry import everything from `./followups`.

`daysBetween` parses both dates as UTC midnight deliberately. Both operands are already local dates in the same zone, so the arithmetic is a plain calendar-day difference and introducing a zone here would double-apply the offset.

- [ ] **Step 5: Modify `getPerson` in `src/tools/people.ts`**

A diff against the current body. Tasks 7 and 10 already added their lines; leave them alone.

Add to the imports at the top of `people.ts`:

```ts
import { loadOpenFollowups } from "./followups_read";
```

Inside `getPerson`, alongside the other loads, add:

```ts
  const openFollowups = await loadOpenFollowups(ctx, id);
```

Then replace this line of the returned object literal:

```ts
    open_followups: [],
```

with:

```ts
    open_followups: openFollowups,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/followups.test.ts tests/people.test.ts`
Expected: PASS, all eleven follow-up cases.

- [ ] **Step 7: Commit**

```bash
git add src/tools/followups_read.ts src/tools/followups.ts src/tools/people.ts tests/followups.test.ts
git commit -m "feat: add follow-ups and timezone-correct list_due"
```

---

### Task 12a: Import parsing, source records, and run state

**Files:**
- Create: `src/tools/import_state.ts`
- Test: `tests/import-state.test.ts`

**Interfaces:**
- Consumes: `roster_sources`, `import_runs` from Task 3; `hashJson`; `newId`; `assertId`.
- Produces:
  - `const IMPORT_BATCH_LIMIT = 150`
  - `const UPSERT_ROWS_PER_STATEMENT = 6`
  - `interface RosterRow { external_row_key?: string; full_name: string; preferred_name?: string; job_title?: string; organization?: string; email?: string; role?: string; raw?: unknown }`
  - `interface RunState { run_id: string; roster_source_id: string; expected_total: number; next_offset: number }`
  - `function parseCsv(text: string): Record<string, string>[]`
  - `function rowKey(row: RosterRow): Promise<string>`
  - `function ensureSource(ctx, input): Promise<string>`
  - `function openOrResumeRun(ctx, sourceId, input, inputHash, start): Promise<RunState>`

Task 12 was one task in the first draft and is three here. It is the task every reviewer rejected, on three separate counts: it issued one D1 query per row against a 50-query cap, it counted inserts and updates from `meta.changes` and `meta.last_row_id` in a way SQLite does not support, and it accepted a `run_id` from the caller without checking that the continuation belonged to that run. Those are three different problems in three different layers, and a single agent holding all of it at once is how the first version came to be wrong. This task is the state layer, 12b is the write path, and 12c is finalization.

**A cost worth knowing about.** The protocol takes the entire `rows` array on every call and slices it server-side, per the spec's tool contract. That makes the run's input hash checkable and the cursor meaningful, and it means a 798-row roster is re-sent by the agent on each of six calls. See the note at the end of this plan; it is the spec's contract and this plan implements it rather than quietly changing it.

- [ ] **Step 1: Write the failing test `tests/import-state.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { hashJson } from "../src/idempotency";
import { ensureSource, openOrResumeRun, parseCsv, rowKey } from "../src/tools/import_state";

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
  format: "json" as const,
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

describe("rowKey", () => {
  it("uses the source's key when it has one", async () => {
    expect(await rowKey({ external_row_key: "row-7", full_name: "Ada" })).toBe("row-7");
  });

  it("hashes the content when the source has none", async () => {
    const a = await rowKey({ full_name: "Ada Lovelace", organization: "Kinsta" });
    const b = await rowKey({ organization: "Kinsta", full_name: "Ada Lovelace" });
    expect(a).toMatch(/^sha256:/);
    expect(a).toBe(b);
  });

  it("gives two same-named people different keys when their rows differ", async () => {
    const a = await rowKey({ full_name: "Chris Smith", organization: "A" });
    const b = await rowKey({ full_name: "Chris Smith", organization: "B" });
    expect(a).not.toBe(b);
  });
});

describe("ensureSource", () => {
  it("creates once and returns the same id afterwards", async () => {
    const first = await ensureSource(ctx, SOURCE);
    const second = await ensureSource(ctx, SOURCE);
    expect(first).toMatch(/^rs_/);
    expect(second).toBe(first);
  });
});

describe("openOrResumeRun", () => {
  const rows = [{ external_row_key: "1", full_name: "Ada" }];

  it("opens a run on a first call", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const run = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows }, await hashJson(rows), 0);
    expect(run.run_id).toMatch(/^ir_/);
    expect(run.expected_total).toBe(1);
    expect(run.next_offset).toBe(0);
  });

  it("refuses a first call that starts partway through", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    await expect(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows }, await hashJson(rows), 5)
    ).rejects.toThrow(ToolError);
  });

  it("resumes a run at the offset it expects", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const hash = await hashJson(rows);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows }, hash, 0);
    await env.DB.prepare("UPDATE import_runs SET next_offset = 1 WHERE id = ?")
      .bind(opened.run_id)
      .run();

    const resumed = await openOrResumeRun(
      ctx,
      sourceId,
      { ...SOURCE, rows, run_id: opened.run_id },
      hash,
      1
    );
    expect(resumed.run_id).toBe(opened.run_id);
    expect(resumed.next_offset).toBe(1);
  });

  it("refuses a continuation whose cursor skips rows", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const hash = await hashJson(rows);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows }, hash, 0);
    await expect(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, run_id: opened.run_id }, hash, 1)
    ).rejects.toThrow(ToolError);
  });

  it("refuses a continuation carrying different rows", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows }, await hashJson(rows), 0);
    const tampered = [{ external_row_key: "1", full_name: "Someone Else" }];
    await expect(
      openOrResumeRun(
        ctx,
        sourceId,
        { ...SOURCE, rows: tampered, run_id: opened.run_id },
        await hashJson(tampered),
        0
      )
    ).rejects.toThrow(ToolError);
  });

  it("refuses a run belonging to another source", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    const hash = await hashJson(rows);
    const opened = await openOrResumeRun(ctx, sourceId, { ...SOURCE, rows }, hash, 0);

    const otherId = await ensureSource(ctx, { ...SOURCE, source_key: "wceu-2026" });
    await expect(
      openOrResumeRun(ctx, otherId, { ...SOURCE, rows, run_id: opened.run_id }, hash, 0)
    ).rejects.toThrow(ToolError);
  });

  it("rejects a run id of the wrong kind", async () => {
    const sourceId = await ensureSource(ctx, SOURCE);
    await expect(
      openOrResumeRun(ctx, sourceId, { ...SOURCE, rows, run_id: "rs_nope" }, await hashJson(rows), 0)
    ).rejects.toThrow(ToolError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/import-state.test.ts`
Expected: FAIL, cannot resolve `../src/tools/import_state`.

- [ ] **Step 3: Write `src/tools/import_state.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { hashJson } from "../idempotency";
import { nowIso } from "../time";

/**
 * Rows accepted per call. Chosen from the free-plan budget of 50 D1 queries per
 * Worker invocation, not from what feels tidy: one source lookup, one run read or
 * insert, two chunked key pre-checks, 25 batched upserts of six rows each, one run
 * update, and two more if the caller passed an idempotency_key. That is about 32.
 */
export const IMPORT_BATCH_LIMIT = 150;

/** 15 bound columns per row against D1's 100-parameter statement cap. */
export const UPSERT_ROWS_PER_STATEMENT = 6;

/** Key pre-checks bind the source id plus this many keys, staying under 100. */
export const KEY_LOOKUP_CHUNK = 99;

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

export interface ImportRosterInput {
  source_key: string;
  label: string;
  source_url: string;
  format: "csv" | "json" | "text";
  rows: RosterRow[];
  event?: string;
  run_id?: string;
  cursor?: string;
  idempotency_key?: string;
}

export interface RunState {
  run_id: string;
  roster_source_id: string;
  expected_total: number;
  next_offset: number;
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

export async function rowKey(row: RosterRow): Promise<string> {
  if (typeof row.external_row_key === "string" && row.external_row_key.trim() !== "") {
    return row.external_row_key.trim();
  }
  const { external_row_key, raw, ...content } = row;
  return `sha256:${await hashJson(content)}`;
}

export async function ensureSource(
  ctx: ToolContext,
  input: Pick<ImportRosterInput, "source_key" | "label" | "event" | "source_url">
): Promise<string> {
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

export async function openOrResumeRun(
  ctx: ToolContext,
  sourceId: string,
  input: ImportRosterInput,
  inputHash: string,
  start: number
): Promise<RunState> {
  if (input.run_id === undefined) {
    if (start !== 0) {
      throw new ToolError("invalid_input", "a cursor without a run_id has nothing to continue");
    }
    const runId = newId("ir");
    await ctx.db
      .prepare(
        `INSERT INTO import_runs
           (id, roster_source_id, format, input_hash, status, expected_total, next_offset, started_at)
         VALUES (?, ?, ?, ?, 'open', ?, 0, ?)`
      )
      .bind(runId, sourceId, input.format, inputHash, input.rows.length, nowIso(ctx.clock))
      .run();
    return {
      run_id: runId,
      roster_source_id: sourceId,
      expected_total: input.rows.length,
      next_offset: 0,
    };
  }

  const runId = assertId("ir", input.run_id);
  const run = await ctx.db
    .prepare(
      `SELECT id, roster_source_id, input_hash, format, status, expected_total, next_offset
       FROM import_runs WHERE id = ?`
    )
    .bind(runId)
    .first<{
      id: string;
      roster_source_id: string;
      input_hash: string;
      format: string;
      status: string;
      expected_total: number;
      next_offset: number;
    }>();

  if (!run) throw new ToolError("not_found", `no import run with id ${runId}`);
  if (
    run.roster_source_id !== sourceId ||
    run.input_hash !== inputHash ||
    run.format !== input.format ||
    run.status !== "open" ||
    run.next_offset !== start
  ) {
    throw new ToolError(
      "conflict",
      "import continuation does not match its open run; start a new run without a run_id"
    );
  }

  return {
    run_id: run.id,
    roster_source_id: run.roster_source_id,
    expected_total: run.expected_total,
    next_offset: run.next_offset,
  };
}
```

Five things are checked on a continuation, and each one is a way a resumed import goes wrong. A `run_id` from another source attaches rows from roster B to roster A. A different `input_hash` means the caller changed the data mid-run, so the run's `expected_total` no longer describes what is being imported. A different format means the same. A run that is not open has already been finalized. And a cursor that does not equal `next_offset` either skips rows, which a later `finalizeImport` would then retire as missing, or replays rows already committed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/import-state.test.ts`
Expected: PASS, all fourteen cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/import_state.ts tests/import-state.test.ts
git commit -m "feat: add roster parsing, source records, and validated import run state"
```

---

### Task 12b: Batched roster upsert

**Files:**
- Create: `src/tools/import.ts`
- Test: `tests/import.test.ts`

**Interfaces:**
- Consumes: everything Task 12a produces, plus `withIdempotency`.
- Produces:
  - `interface ImportResult { run_id: string; roster_source_id: string; imported: number; updated: number; skipped: number; total_seen: number; next_cursor: string | null; errors: { index: number; reason: string }[] }`
  - `function importRoster(ctx, input): Promise<ImportResult>`

The write path has two hard constraints and one thing that cannot be done the obvious way. The constraints are 50 D1 queries per invocation and 100 bound parameters per statement. The thing that cannot be done the obvious way is telling an insert from an update: SQLite reports one changed row for both branches of an `INSERT ... ON CONFLICT DO UPDATE`, and `last_insert_rowid()` holds whatever the last successful insert on the connection set, so neither field discriminates. The first draft's comment claiming `meta.changes` is 2 for an upsert is wrong, and its idempotency test would have failed against it.

Both problems have the same answer: look up which keys already exist, in bulk, before writing. That is two queries for a 150-row batch instead of 150, and it produces exact counts.

- [ ] **Step 1: Write the failing test `tests/import.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { importRoster } from "../src/tools/import";
import { IMPORT_BATCH_LIMIT } from "../src/tools/import_state";

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
  format: "json" as const,
};

async function countEntries(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM roster_entries").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("importRoster", () => {
  it("creates the source and run on the first call", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", organization: "Kinsta" }],
    });
    expect(out.run_id).toMatch(/^ir_/);
    expect(out.roster_source_id).toMatch(/^rs_/);
    expect(out.imported).toBe(1);
    expect(out.updated).toBe(0);
    expect(out.next_cursor).toBeNull();
  });

  it("counts a re-import as updated, not imported", async () => {
    const rows = [{ external_row_key: "1", full_name: "Ada Lovelace" }];
    const first = await importRoster(ctx, { ...SOURCE, rows });
    const second = await importRoster(ctx, { ...SOURCE, rows });
    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);
    expect(await countEntries()).toBe(1);
  });

  it("updates the stored row on re-import", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", organization: "Kinsta" }],
    });
    await importRoster(ctx, {
      ...SOURCE,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace", organization: "Automattic" }],
    });
    const row = await env.DB.prepare(
      "SELECT organization FROM roster_entries WHERE external_row_key = ?"
    )
      .bind("1")
      .first<{ organization: string }>();
    expect(row?.organization).toBe("Automattic");
  });

  it("derives a stable row key by content hash when the source has none", async () => {
    const rows = [{ full_name: "Ada Lovelace", organization: "Kinsta" }];
    await importRoster(ctx, { ...SOURCE, rows });
    await importRoster(ctx, { ...SOURCE, rows });
    expect(await countEntries()).toBe(1);
  });

  it("never treats a name as an identity", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      rows: [
        { external_row_key: "1", full_name: "Chris Smith", organization: "A" },
        { external_row_key: "2", full_name: "Chris Smith", organization: "B" },
      ],
    });
    expect(await countEntries()).toBe(2);
  });

  it("caps a batch at the server constant and returns a cursor", async () => {
    const rows = Array.from({ length: IMPORT_BATCH_LIMIT + 25 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    const first = await importRoster(ctx, { ...SOURCE, rows });
    expect(first.imported).toBe(IMPORT_BATCH_LIMIT);
    expect(first.next_cursor).toBe(String(IMPORT_BATCH_LIMIT));

    const second = await importRoster(ctx, {
      ...SOURCE,
      rows,
      run_id: first.run_id,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.imported).toBe(25);
    expect(second.next_cursor).toBeNull();
    expect(await countEntries()).toBe(IMPORT_BATCH_LIMIT + 25);
  });

  it("refuses a continuation that skips rows", async () => {
    const rows = Array.from({ length: IMPORT_BATCH_LIMIT + 25 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    const first = await importRoster(ctx, { ...SOURCE, rows });
    await expect(
      importRoster(ctx, {
        ...SOURCE,
        rows,
        run_id: first.run_id,
        cursor: String(IMPORT_BATCH_LIMIT + 10),
      })
    ).rejects.toThrow(ToolError);
  });

  it("reports per-row errors instead of failing the whole batch", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace" },
        { external_row_key: "2", full_name: "   " },
      ],
    });
    expect(out.imported).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.errors).toEqual([{ index: 1, reason: "full_name is required" }]);
  });

  it("keeps the last of two rows sharing one key within a call", async () => {
    const out = await importRoster(ctx, {
      ...SOURCE,
      rows: [
        { external_row_key: "1", full_name: "Ada Lovelace", organization: "First" },
        { external_row_key: "1", full_name: "Ada Lovelace", organization: "Second" },
      ],
    });
    expect(out.imported).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.errors[0]?.index).toBe(0);
    expect(out.errors[0]?.reason).toMatch(/duplicate/);
    expect(await countEntries()).toBe(1);

    const row = await env.DB.prepare(
      "SELECT organization FROM roster_entries WHERE external_row_key = ?"
    )
      .bind("1")
      .first<{ organization: string }>();
    expect(row?.organization).toBe("Second");
  });

  it("stores provenance on every row", async () => {
    await importRoster(ctx, {
      ...SOURCE,
      rows: [{ external_row_key: "1", full_name: "Ada Lovelace" }],
    });
    const row = await env.DB.prepare(
      "SELECT source_url, source_captured_at, raw_record, last_seen_run_id FROM roster_entries LIMIT 1"
    ).first<{
      source_url: string;
      source_captured_at: string;
      raw_record: string;
      last_seen_run_id: string;
    }>();
    expect(row?.source_url).toBe(SOURCE.source_url);
    expect(row?.source_captured_at).toBe("2026-08-20T12:00:00.000Z");
    expect(row?.last_seen_run_id).toMatch(/^ir_/);
    expect(JSON.parse(row?.raw_record ?? "{}")).toEqual(
      expect.objectContaining({ full_name: "Ada Lovelace" })
    );
  });

  it("replays under the same idempotency_key without writing twice", async () => {
    const rows = [{ external_row_key: "1", full_name: "Ada Lovelace" }];
    const args = { ...SOURCE, rows, idempotency_key: "k1" };
    const first = await importRoster(ctx, args);
    const second = await importRoster(ctx, args);
    expect(second).toEqual(first);
    expect(await countEntries()).toBe(1);
  });

  it("rejects a rows argument that is not an array", async () => {
    await expect(
      importRoster(ctx, { ...SOURCE, rows: "not an array" as never })
    ).rejects.toThrow(ToolError);
  });

  it("rejects a batch larger than the server constant would allow to be requested", async () => {
    // The cap is a server constant. A caller cannot raise it, and asking for more
    // rows in one call simply produces a cursor rather than a bigger batch.
    const rows = Array.from({ length: IMPORT_BATCH_LIMIT * 2 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    const out = await importRoster(ctx, { ...SOURCE, rows });
    expect(out.imported).toBe(IMPORT_BATCH_LIMIT);
    expect(out.next_cursor).not.toBeNull();
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
import { hashJson, withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import {
  ensureSource,
  IMPORT_BATCH_LIMIT,
  KEY_LOOKUP_CHUNK,
  openOrResumeRun,
  rowKey,
  UPSERT_ROWS_PER_STATEMENT,
  type ImportRosterInput,
  type RosterRow,
} from "./import_state";

export {
  ensureSource,
  IMPORT_BATCH_LIMIT,
  parseCsv,
  type ImportRosterInput,
  type RosterRow,
} from "./import_state";

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

const ENTRY_COLUMNS = [
  "id",
  "roster_source_id",
  "external_row_key",
  "full_name",
  "preferred_name",
  "job_title",
  "organization",
  "email",
  "role",
  "source_url",
  "source_captured_at",
  "raw_record",
  "last_seen_run_id",
  "created_at",
  "updated_at",
] as const;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Which of these keys already exist under this source, in as few queries as possible. */
async function existingKeys(
  ctx: ToolContext,
  sourceId: string,
  keys: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunk(keys, KEY_LOOKUP_CHUNK)) {
    if (part.length === 0) continue;
    const marks = part.map(() => "?").join(", ");
    const { results } = await ctx.db
      .prepare(
        `SELECT external_row_key FROM roster_entries
         WHERE roster_source_id = ? AND external_row_key IN (${marks})`
      )
      .bind(sourceId, ...part)
      .all<{ external_row_key: string }>();
    for (const row of results) found.add(row.external_row_key);
  }
  return found;
}

interface PreparedRow {
  key: string;
  values: (string | null)[];
}

function upsertStatement(ctx: ToolContext, rows: PreparedRow[]): D1PreparedStatement {
  const placeholders = rows
    .map(() => `(${ENTRY_COLUMNS.map(() => "?").join(", ")})`)
    .join(", ");

  return ctx.db
    .prepare(
      `INSERT INTO roster_entries (${ENTRY_COLUMNS.join(", ")})
       VALUES ${placeholders}
       ON CONFLICT (roster_source_id, external_row_key) DO UPDATE SET
         full_name = excluded.full_name,
         preferred_name = excluded.preferred_name,
         job_title = excluded.job_title,
         organization = excluded.organization,
         email = excluded.email,
         role = excluded.role,
         source_url = excluded.source_url,
         source_captured_at = excluded.source_captured_at,
         raw_record = excluded.raw_record,
         last_seen_run_id = excluded.last_seen_run_id,
         retired_at = NULL,
         updated_at = excluded.updated_at`
    )
    .bind(...rows.flatMap((r) => r.values));
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

  const start = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isInteger(start) || start < 0) {
    throw new ToolError("invalid_input", "cursor must be a non-negative integer");
  }

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "import_roster", idempotency_key, rest, async () => {
    const sourceId = await ensureSource(ctx, input);
    const inputHash = await hashJson(input.rows);
    const run = await openOrResumeRun(ctx, sourceId, input, inputHash, start);

    const at = nowIso(ctx.clock);
    const slice = input.rows.slice(start, start + IMPORT_BATCH_LIMIT);
    const errors: { index: number; reason: string }[] = [];

    // Prepare every row first, so validation and key derivation are done before
    // anything is written and the whole slice can go out in one batch.
    const prepared = new Map<string, PreparedRow>();
    const seenAt = new Map<string, number>();
    const order: string[] = [];

    for (let offset = 0; offset < slice.length; offset++) {
      const row = slice[offset] as RosterRow;
      const index = start + offset;

      if (typeof row.full_name !== "string" || row.full_name.trim() === "") {
        errors.push({ index, reason: "full_name is required" });
        continue;
      }

      const key = await rowKey(row);
      const earlier = seenAt.get(key);
      if (earlier !== undefined) {
        // SQLite refuses to upsert the same row twice in one statement. The earlier
        // occurrence is dropped and reported at its own index; the last one wins.
        errors.push({
          index: earlier,
          reason: `duplicate row key ${key}; superseded by a later row in this call`,
        });
      } else {
        order.push(key);
      }
      seenAt.set(key, index);

      prepared.set(key, {
        key,
        values: [
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
          run.run_id,
          at,
          at,
        ],
      });
    }

    const keys = order;
    const existing = await existingKeys(ctx, sourceId, keys);
    const imported = keys.filter((k) => !existing.has(k)).length;
    const updated = keys.length - imported;

    const statements = chunk(
      keys.map((k) => prepared.get(k) as PreparedRow),
      UPSERT_ROWS_PER_STATEMENT
    ).map((part) => upsertStatement(ctx, part));

    const consumed = start + slice.length;

    statements.push(
      ctx.db
        .prepare(
          `UPDATE import_runs
             SET inserted_count = inserted_count + ?,
                 updated_count = updated_count + ?,
                 skipped_count = skipped_count + ?,
                 next_offset = ?
           WHERE id = ?`
        )
        .bind(imported, updated, errors.length, consumed, run.run_id)
    );

    // One batch: D1 runs it as a transaction, so a failed statement rolls back the
    // writes and the run's next_offset with them. A retry then resumes cleanly.
    await ctx.db.batch(statements);

    return {
      run_id: run.run_id,
      roster_source_id: sourceId,
      imported,
      updated,
      skipped: errors.length,
      total_seen: input.rows.length,
      next_cursor: consumed < input.rows.length ? String(consumed) : null,
      errors,
    };
  });
}
```

Three things in there are worth stating plainly, because each replaces something the first draft got wrong.

**Counting comes from the pre-check, not from `meta`.** `existingKeys` asks which of this slice's keys are already stored, in two queries for a full batch. Every key it returns is an update and every key it does not is an insert. This is exact, it is cheap, and it does not depend on any D1 metadata behavior.

**The whole slice goes out as one `db.batch()`.** That is 25 upsert statements plus the run update for a 150-row batch, against a 50-query invocation budget. The first draft's loop issued one query per row, so a 200-row batch was over 200 queries and would have failed in production while passing locally, since Miniflare does not enforce the plan limit. The batch is also transactional, which is what makes `next_offset` trustworthy: the offset advances in the same transaction as the rows it describes.

**Duplicate keys within one call are resolved before writing.** SQLite refuses to let one `INSERT ... ON CONFLICT DO UPDATE` statement update the same row twice, and a roster pasted by hand can easily repeat a row. Last occurrence wins, the earlier one is reported as a skipped row with a reason, and the batch survives.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/import.test.ts`
Expected: PASS, all thirteen cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/import.ts tests/import.test.ts
git commit -m "feat: add batched roster import with exact insert and update counts"
```

---

### Task 12c: Import finalization and retirement

**Files:**
- Modify: `src/tools/import.ts`
- Test: `tests/import-finalize.test.ts`

**Interfaces:**
- Consumes: `import_runs`, `roster_entries`, `withIdempotency`.
- Produces:
  - `function finalizeImport(ctx, input): Promise<{ run_id: string; retired: number; status: "committed" }>`

Finalization is where a roster row that vanished from the source gets marked `retired_at`, and it is the one call in the import protocol that can destroy information. It is separate from the write path because it has a precondition the write path does not: a run may only claim full coverage if it actually consumed every row it was opened against.

- [ ] **Step 1: Write the failing test `tests/import-finalize.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { finalizeImport, importRoster } from "../src/tools/import";
import { IMPORT_BATCH_LIMIT } from "../src/tools/import_state";

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
  format: "json" as const,
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
  await env.DB.prepare("DELETE FROM idempotency_keys").run();
});

describe("finalizeImport", () => {
  it("retires rows the run did not see when it claims full coverage", async () => {
    const first = await importRoster(ctx, {
      ...SOURCE,
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id, full_coverage: true });

    const second = await importRoster(ctx, {
      ...SOURCE,
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

  it("refuses full coverage for a run that has not consumed every row", async () => {
    const rows = Array.from({ length: IMPORT_BATCH_LIMIT + 25 }, (_, i) => ({
      external_row_key: String(i),
      full_name: `Person ${i}`,
    }));
    const first = await importRoster(ctx, { ...SOURCE, rows });
    expect(first.next_cursor).not.toBeNull();

    await expect(
      finalizeImport(ctx, { run_id: first.run_id, full_coverage: true })
    ).rejects.toThrow(ToolError);

    const retired = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roster_entries WHERE retired_at IS NOT NULL"
    ).first<{ n: number }>();
    expect(retired?.n).toBe(0);
  });

  it("never retires a row that was promoted to a person", async () => {
    const first = await importRoster(ctx, {
      ...SOURCE,
      rows: [
        { external_row_key: "1", full_name: "Ada" },
        { external_row_key: "2", full_name: "Grace" },
      ],
    });
    await finalizeImport(ctx, { run_id: first.run_id, full_coverage: true });

    const entry = await env.DB.prepare(
      "SELECT id FROM roster_entries WHERE external_row_key = ?"
    )
      .bind("2")
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO people (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("p_1", "Grace", "2026-08-20T12:00:00.000Z", "2026-08-20T12:00:00.000Z")
      .run();
    await env.DB.prepare(
      "INSERT INTO person_roster_entries (person_id, roster_entry_id, linked_at) VALUES (?, ?, ?)"
    )
      .bind("p_1", entry?.id, "2026-08-20T12:00:00.000Z")
      .run();

    const second = await importRoster(ctx, {
      ...SOURCE,
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const out = await finalizeImport(ctx, { run_id: second.run_id, full_coverage: true });
    expect(out.retired).toBe(0);
  });

  it("refuses to finalize a run twice", async () => {
    const run = await importRoster(ctx, {
      ...SOURCE,
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    await finalizeImport(ctx, { run_id: run.run_id, full_coverage: true });
    await expect(
      finalizeImport(ctx, { run_id: run.run_id, full_coverage: true })
    ).rejects.toThrow(ToolError);
  });

  it("replays a finalize the client retried", async () => {
    const run = await importRoster(ctx, {
      ...SOURCE,
      rows: [{ external_row_key: "1", full_name: "Ada" }],
    });
    const args = { run_id: run.run_id, full_coverage: true, idempotency_key: "k1" };
    const first = await finalizeImport(ctx, args);
    const second = await finalizeImport(ctx, args);
    expect(second).toEqual(first);
  });

  it("rejects a run id of the wrong kind", async () => {
    await expect(
      finalizeImport(ctx, { run_id: "rs_nope", full_coverage: true })
    ).rejects.toThrow(ToolError);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/import-finalize.test.ts`
Expected: FAIL, `finalizeImport` is not exported from `../src/tools/import`.

- [ ] **Step 3: Append `finalizeImport` to `src/tools/import.ts`**

```ts
export interface FinalizeImportInput {
  run_id: string;
  full_coverage: boolean;
  idempotency_key?: string;
}

export async function finalizeImport(
  ctx: ToolContext,
  input: FinalizeImportInput
): Promise<{ run_id: string; retired: number; status: "committed" }> {
  const runId = assertId("ir", input.run_id);

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "finalize_import", idempotency_key, rest, async () => {
    const run = await ctx.db
      .prepare(
        `SELECT id, roster_source_id, status, expected_total, next_offset
         FROM import_runs WHERE id = ?`
      )
      .bind(runId)
      .first<{
        id: string;
        roster_source_id: string;
        status: string;
        expected_total: number;
        next_offset: number;
      }>();

    if (!run) throw new ToolError("not_found", `no import run with id ${runId}`);
    if (run.status !== "open") {
      throw new ToolError("conflict", `import run ${runId} is already ${run.status}`);
    }
    if (input.full_coverage && run.next_offset !== run.expected_total) {
      throw new ToolError(
        "conflict",
        `import run ${runId} has committed ${run.next_offset} of ${run.expected_total} rows; ` +
          "finish the run before claiming full coverage"
      );
    }

    const at = nowIso(ctx.clock);
    let retired = 0;

    if (input.full_coverage) {
      const result = await ctx.db
        .prepare(
          `UPDATE roster_entries
             SET retired_at = ?, updated_at = ?
           WHERE roster_source_id = ?
             AND last_seen_run_id != ?
             AND retired_at IS NULL
             AND id NOT IN (SELECT roster_entry_id FROM person_roster_entries)`
        )
        .bind(at, at, run.roster_source_id, run.id)
        .run();
      retired = result.meta.changes;
    }

    await ctx.db
      .prepare(
        `UPDATE import_runs
           SET status = 'committed', full_coverage = ?, retired_count = ?, finished_at = ?
         WHERE id = ?`
      )
      .bind(input.full_coverage ? 1 : 0, retired, at, run.id)
      .run();

    return { run_id: run.id, retired, status: "committed" as const };
  });
}
```

Add `assertId` to the imports at the top of the file if it is not already there.

Two guards here are the reason this is its own task. **A run may only claim full coverage once it has consumed every row it was opened against,** because `full_coverage: true` is what turns "this row was not in the input" into `retired_at`. A caller that imported the first 150 rows of 798 and then finalized would retire 648 rows that are perfectly current. **A promoted entry is never retired,** which the spec states and the first draft's SQL did not implement: the `NOT IN` subquery against `person_roster_entries` is what enforces it, and the test for it seeds a promotion by hand because Task 13 has not been written yet.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/import-finalize.test.ts tests/import.test.ts`
Expected: PASS, all seven finalize cases and the thirteen from Task 12b.

- [ ] **Step 5: Commit**

```bash
git add src/tools/import.ts tests/import-finalize.test.ts
git commit -m "feat: add import finalization with coverage and promotion guards"
```

---

### Task 13: Two-phase `promote`

**Files:**
- Create: `src/tools/promote_read.ts`, `src/tools/promote.ts`
- Modify: `src/tools/people.ts` - `getPerson` returns real `sources`
- Test: `tests/promote.test.ts`

**Interfaces:**
- Consumes: `roster_entries`, `person_sources`, `person_roster_entries`, the `Source` type from `src/types.ts`.
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

  it("reports a missing link target as not_found, not as a database error", async () => {
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada Lovelace" });
    try {
      await promote(ctx, { roster_entry_id: entryId, link_to_person_id: newId("p") });
      throw new Error("expected promote to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("not_found");
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM person_roster_entries"
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("refuses to promote one roster entry onto a second person", async () => {
    const entryId = await importOne({ external_row_key: "1", full_name: "Ada Lovelace" });
    const other = await createPerson(ctx, { full_name: "Someone Else" });
    const first = await promote(ctx, { roster_entry_id: entryId, create_new: true });
    if (first.status !== "promoted") throw new Error("unreachable");

    // The entry is already linked, so this returns the original person rather than
    // relinking. One roster row is one human.
    const second = await promote(ctx, {
      roster_entry_id: entryId,
      link_to_person_id: other.id,
    });
    if (second.status !== "promoted") throw new Error("unreachable");
    expect(second.person.id).toBe(first.person.id);
  });

  it("writes the person, the email, and the provenance together or not at all", async () => {
    const entryId = await importOne({
      external_row_key: "1",
      full_name: "Ada Lovelace",
      email: "ada@example.test",
    });
    const out = await promote(ctx, { roster_entry_id: entryId, create_new: true });
    if (out.status !== "promoted") throw new Error("unreachable");

    expect(out.person.contacts).toHaveLength(1);
    expect(out.person.contacts[0]?.value).toBe("ada@example.test");
    expect(out.person.sources).toHaveLength(1);

    const linked = await env.DB.prepare(
      "SELECT person_id FROM person_roster_entries WHERE roster_entry_id = ?"
    )
      .bind(entryId)
      .first<{ person_id: string }>();
    expect(linked?.person_id).toBe(out.person.id);
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

- [ ] **Step 3: Write `src/tools/promote_read.ts`**

```ts
import type { ToolContext } from "../context";
import type { Source } from "../types";

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
```

- [ ] **Step 4: Write `src/tools/promote.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";
import { assertId, newId } from "../ids";
import { withIdempotency } from "../idempotency";
import { nowIso } from "../time";
import type { PersonDetail, Source } from "../types";
import { getPerson } from "./people";
import { loadPersonSources } from "./promote_read";

export type { Source } from "../types";
export { loadPersonSources } from "./promote_read";

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
  idempotency_key?: string;
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

  // Phase one writes nothing.
  if (!wantsLink && !wantsNew) {
    const { raw_record, ...preview } = entry;
    return {
      status: "candidates",
      roster_entry_id: entryId,
      preview,
      candidates: await findCandidates(ctx, entry),
    };
  }

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "promote", idempotency_key, rest, async () => {
    const already = await ctx.db
      .prepare("SELECT person_id FROM person_roster_entries WHERE roster_entry_id = ?")
      .bind(entryId)
      .first<{ person_id: string }>();

    if (already) {
      return {
        status: "promoted" as const,
        person: await getPerson(ctx, { person_id: already.person_id }),
        linked_existing: true,
      };
    }

    const at = nowIso(ctx.clock);
    const rawHash = `sha256:${await sha256Hex(entry.raw_record)}`;

    const provenance = (personId: string) => [
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
    ];

    if (wantsLink) {
      const personId = assertId("p", input.link_to_person_id);
      const exists = await ctx.db
        .prepare("SELECT id FROM people WHERE id = ?")
        .bind(personId)
        .first<{ id: string }>();
      if (!exists) throw new ToolError("not_found", `no person with id ${personId}`);

      await ctx.db.batch(provenance(personId));

      return {
        status: "promoted" as const,
        person: await getPerson(ctx, { person_id: personId }),
        linked_existing: true,
      };
    }

    // Creating a person, its email, and its provenance is one transaction. The id is
    // minted here rather than returned by a helper so every statement can be batched.
    const personId = newId("p");
    const statements = [
      ctx.db
        .prepare(
          `INSERT INTO people (id, full_name, preferred_name, job_title, organization, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          personId,
          entry.full_name,
          entry.preferred_name,
          entry.job_title,
          entry.organization,
          at,
          at
        ),
      ...(entry.email
        ? [
            ctx.db
              .prepare(
                `INSERT INTO person_contacts (id, person_id, contact_type, value, label, created_at)
                 VALUES (?, ?, 'email', ?, NULL, ?)
                 ON CONFLICT (person_id, contact_type, value) DO NOTHING`
              )
              .bind(newId("pc"), personId, entry.email, at),
          ]
        : []),
      ...provenance(personId),
    ];

    await ctx.db.batch(statements);

    return {
      status: "promoted" as const,
      person: await getPerson(ctx, { person_id: personId }),
      linked_existing: false,
    };
  });
}
```

Name matching appears here, and only here, as *evidence shown to a human or an agent*. It never selects a person. That distinction is the whole reason `promote` has two phases, and it is why the second phase requires an explicit `link_to_person_id` rather than accepting the top candidate.

**Committing a promotion is one transaction.** The first draft called `createPerson`, then `addContact`, then batched the two provenance rows, which is three separate writes. A failure after the first leaves a person with no provenance and no link to the roster row that produced them, and the retry creates a second person, because nothing yet records that the entry was promoted. Minting the person id inline and batching every insert makes the whole promotion land or none of it. It is also why this path does not call the public `createPerson` and `addContact` tools: those wrap themselves in their own idempotency handling and cannot be enlisted in someone else's transaction.

**A named person is checked before anything is written.** `link_to_person_id` pointing at a person who does not exist previously surfaced as a raw D1 foreign-key error rather than `not_found`, which is both a worse message and a different error shape than every other tool in the module produces.

- [ ] **Step 5: Modify `getPerson` in `src/tools/people.ts`**

The last diff against this function. Tasks 7, 10, and 11 already added theirs.

Add to the imports at the top of `people.ts`:

```ts
import { loadPersonSources } from "./promote_read";
```

Inside `getPerson`, alongside the other loads, add:

```ts
  const sources = await loadPersonSources(ctx, id);
```

Then replace this line of the returned object literal:

```ts
    sources: [],
```

with:

```ts
    sources,
```

Every placeholder in `PersonDetail` is now filled. `getPerson` imports from four `_read` modules and none of them imports `people.ts`, so the graph stays acyclic and there is no dynamic import anywhere in the module.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/promote.test.ts tests/people.test.ts`
Expected: PASS, all thirteen promote cases. The purge case is the one that proves durable provenance no longer depends on staged data, and the all-or-nothing case is the one that proves a promotion cannot leave a person behind with no origin.

- [ ] **Step 7: Commit**

```bash
git add src/tools/promote_read.ts src/tools/promote.ts src/tools/people.ts tests/promote.test.ts
git commit -m "feat: add two-phase promote with durable provenance copying"
```

---

### Task 14: Roster administration

**Files:**
- Create: `src/tools/roster_admin.ts`
- Test: `tests/roster-admin.test.ts`

**Interfaces:**
- Consumes: `mintConfirmation`, `redeemConfirmation`, `withIdempotency`, `assertId`.
- Produces:
  - `function listRosterSources(ctx): Promise<RosterSourceSummary[]>`
  - `function purgeRosterSource(ctx, input): Promise<PurgeResult>`

Purging is the second of the two two-call destructive operations, and the only one that removes rows in bulk. It is what makes "staged data is worthless within weeks" an actual capability rather than a description.

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
import { withIdempotency } from "../idempotency";

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
  idempotency_key?: string;
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

  const { idempotency_key, ...rest } = input;
  return withIdempotency(ctx, "purge_roster_source", idempotency_key, rest, async () => {
    await redeemConfirmation(ctx, "purge_roster_source", id, input.confirmation_token);
    const preview = await purgePreview(ctx, id);
    await ctx.db.prepare("DELETE FROM roster_sources WHERE id = ?").bind(id).run();
    return { status: "purged" as const, purged: preview };
  });
}
```

Only the commit call is wrapped, for the same reason as `deletePerson`: a replayed preview should mint a fresh token rather than hand back one that may already be spent. And as with `deletePerson`, a retried commit without an idempotency key would present a redeemed token and fail, leaving the caller unable to tell a purge it did not see from a purge that never happened.

Deleting the source cascades to `import_runs`, `roster_entries`, and `person_roster_entries`. It does not touch `people` or `person_sources`, because `person_sources` deliberately has no foreign key back to the staged tables. Task 3's fourth test is what proves this.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/roster-admin.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/roster_admin.ts tests/roster-admin.test.ts
git commit -m "feat: add roster source listing and confirmed purge"
```

---

### Task 15: `export_data`

**Files:**
- Create: `src/tools/export.ts`
- Test: `tests/export.test.ts`

**Interfaces:**
- Consumes: the durable tables, `assertId`.
- Produces:
  - `type ExportScope = "people" | "encounters" | "followups"`
  - `function exportData(ctx, input): Promise<{ scope: ExportScope; results: unknown[]; next_cursor: string | null }>`

The spec keeps `export_data` as a paginated convenience tool: "give me my data" answered in the conversation. It is explicitly **not** the backup. The backup is D1 Time Travel plus a CLI export in plan 3, for a reason worth restating where the tool is built: Anthropic caps a tool result at roughly 150,000 characters, so an export that mattered would be exactly the export that truncated. This tool is scoped and paginated so a caller sees a bounded page and asks for the next one.

The first draft of this plan omitted it and listed it under what the plan does not build, while the spec kept it in the tool surface. That contradiction is resolved in the spec's favor.

- [ ] **Step 1: Write the failing test `tests/export.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { ToolError } from "../src/errors";
import { logEncounter } from "../src/tools/encounters";
import { exportData } from "../src/tools/export";
import { setFollowup } from "../src/tools/followups";
import { createPerson } from "../src/tools/people";

const ctx: ToolContext = {
  db: env.DB,
  timezone: "UTC",
  clock: () => new Date("2026-08-20T12:00:00Z"),
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM people").run();
});

describe("exportData", () => {
  it("defaults to people and returns whole records", async () => {
    await createPerson(ctx, { full_name: "Ada Lovelace", organization: "Kinsta" });
    const out = await exportData(ctx, {});
    expect(out.scope).toBe("people");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toEqual(
      expect.objectContaining({ full_name: "Ada Lovelace", organization: "Kinsta" })
    );
  });

  it("pages with a cursor and terminates", async () => {
    for (let i = 0; i < 5; i++) {
      await createPerson(ctx, { full_name: `Person ${i}` });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await exportData(ctx, { scope: "people", limit: 2, cursor });
      seen.push(...page.results.map((r) => (r as { id: string }).id));
      cursor = page.next_cursor ?? undefined;
      pages++;
      if (pages > 10) throw new Error("export did not terminate");
    } while (cursor !== undefined);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("exports encounters and follow-ups under their own scopes", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await logEncounter(ctx, { person_id: person.id, summary: "hallway track" });
    await setFollowup(ctx, { person_id: person.id, due_on: "2026-09-01", note: "send deck" });

    const encounters = await exportData(ctx, { scope: "encounters" });
    expect(encounters.results).toHaveLength(1);

    const followups = await exportData(ctx, { scope: "followups" });
    expect(followups.results).toHaveLength(1);
  });

  it("never exports staged roster data", async () => {
    await expect(exportData(ctx, { scope: "roster_entries" as never })).rejects.toThrow(ToolError);
  });

  it("clamps a page size the caller asks for at either end", async () => {
    for (let i = 0; i < 3; i++) await createPerson(ctx, { full_name: `Person ${i}` });

    // Below the floor: one row, not zero, and a cursor to continue from.
    const small = await exportData(ctx, { scope: "people", limit: 0 });
    expect(small.results).toHaveLength(1);
    expect(small.next_cursor).not.toBeNull();

    // Above the ceiling: no error, and every row that exists.
    const large = await exportData(ctx, { scope: "people", limit: 10_000 });
    expect(large.results).toHaveLength(3);
    expect(large.next_cursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/export.test.ts`
Expected: FAIL, cannot resolve `../src/tools/export`.

- [ ] **Step 3: Write `src/tools/export.ts`**

```ts
import type { ToolContext } from "../context";
import { ToolError } from "../errors";

export type ExportScope = "people" | "encounters" | "followups";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const QUERIES: Record<ExportScope, string> = {
  people: `SELECT id, full_name, preferred_name, job_title, organization, notes,
                  archived_at, created_at, updated_at
           FROM people`,
  encounters: `SELECT id, person_id, occurred_on, occurred_at, location, event, summary, created_at
               FROM encounters`,
  followups: `SELECT id, person_id, due_on, note, completed_at, cancelled_at, created_at
              FROM followups`,
};

export interface ExportDataInput {
  scope?: ExportScope;
  limit?: number;
  cursor?: string;
}

export async function exportData(
  ctx: ToolContext,
  input: ExportDataInput
): Promise<{ scope: ExportScope; results: unknown[]; next_cursor: string | null }> {
  const scope = input.scope ?? "people";
  const base = QUERIES[scope];
  if (base === undefined) {
    throw new ToolError(
      "invalid_input",
      'scope must be "people", "encounters", or "followups". Staged roster data is not exported; it is re-fetchable from its source.'
    );
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const clause = input.cursor === undefined ? "" : "WHERE id > ?";
  const values = input.cursor === undefined ? [] : [input.cursor];

  const { results } = await ctx.db
    .prepare(`${base} ${clause} ORDER BY id ASC LIMIT ?`)
    .bind(...values, limit + 1)
    .all<Record<string, unknown>>();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  const next =
    results.length > limit && last !== undefined ? String(last["id"]) : null;

  return { scope, results: page, next_cursor: next };
}
```

The cursor is a plain `id > ?` here, unlike `listEncounters`, and that is correct rather than inconsistent: this query orders by `id` alone, so the cursor is the whole sort key. Ordering an export by id also makes it stable while rows are being written, which matters more than presentation order for a tool whose output is fed to something else.

Staged roster data is deliberately not exportable. It is bulk third-party contact data that the spec describes as worthless within weeks and re-fetchable from its source, and handing it back through a conversation is the one thing this tool should not make easy.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/export.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/export.ts tests/export.test.ts
git commit -m "feat: add paginated export_data over durable records"
```

---

### Task 16: The tool registry and contract tests

**Files:**
- Create: `src/tools/schema.ts`, `src/tools/index.ts`
- Test: `tests/contract.test.ts`

**Interfaces:**
- Consumes: every tool written so far.
- Produces:
  - `interface ToolDefinition { name: string; description: string; destructive: boolean; inputSchema: JsonSchema; run(ctx: ToolContext, input: never): Promise<unknown> }`
  - `const TOOLS: Record<string, ToolDefinition>` - the registry plan 2 consumes

The registry is the seam between this plan and plan 2. Plan 2's MCP transport iterates `TOOLS` and needs nothing else from this module, which is what keeps the tool layer transport-agnostic.

**It therefore has to carry input schemas.** The first draft's `ToolDefinition` held a name, a description, a flag, and a function. MCP advertises tools with a JSON Schema for their input, so plan 2 would have had to write 26 schemas somewhere else, next to no tests, duplicating knowledge that lives here. A schema next to the function it describes is a schema that gets updated when the function changes.

Output schemas are deliberately not included. MCP treats them as optional, they are large, and the return types in `src/types.ts` already pin the shapes that matter. That is a judgment call and it is recorded here so plan 2 knows it was made rather than forgotten.

- [ ] **Step 1: Write `src/tools/schema.ts`**

```ts
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export const str = (description: string) => ({ type: "string", description });
export const int = (description: string) => ({ type: "integer", description });
export const bool = (description: string) => ({ type: "boolean", description });
export const enumOf = (values: string[], description: string) => ({
  type: "string",
  enum: values,
  description,
});
export const nullableStr = (description: string) => ({
  type: ["string", "null"],
  description,
});
export const strArray = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});

/** An id of one kind, with the prefix stated in the schema so an agent sees it. */
export const id = (prefix: string, what: string) => ({
  type: "string",
  pattern: `^${prefix}_`,
  description: `${what} id, prefixed "${prefix}_"`,
});

/** Every write tool accepts this; it is added by `obj` rather than repeated. */
const IDEMPOTENCY = {
  idempotency_key: str("Optional. Replaying the same key with the same input returns the original result."),
};

export function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
  options: { idempotent?: boolean } = {}
): JsonSchema {
  return {
    type: "object",
    properties: options.idempotent ? { ...properties, ...IDEMPOTENCY } : properties,
    required,
    additionalProperties: false,
  };
}
```

- [ ] **Step 2: Write `src/tools/index.ts`**

```ts
import type { ToolContext } from "../context";
import { addContact, addLink, removeContact, removeLink, setTags } from "./attributes";
import { deleteEncounter, listEncounters, logEncounter, updateEncounter } from "./encounters";
import { exportData } from "./export";
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
import {
  bool,
  enumOf,
  id,
  int,
  nullableStr,
  obj,
  str,
  strArray,
  type JsonSchema,
} from "./schema";
import { searchPeople } from "./search";

export interface ToolDefinition {
  name: string;
  description: string;
  destructive: boolean;
  inputSchema: JsonSchema;
  run(ctx: ToolContext, input: never): Promise<unknown>;
}

function define<I>(
  name: string,
  description: string,
  destructive: boolean,
  inputSchema: JsonSchema,
  run: (ctx: ToolContext, input: I) => Promise<unknown>
): ToolDefinition {
  return { name, description, destructive, inputSchema, run: run as ToolDefinition["run"] };
}

const personId = id("p", "Person");
const personFields = {
  full_name: str("Full name as written."),
  preferred_name: nullableStr("What they go by, if different."),
  job_title: nullableStr("Job title."),
  organization: nullableStr("Organization, as plain text."),
  notes: nullableStr("Free-text notes."),
};

export const TOOLS: Record<string, ToolDefinition> = Object.fromEntries(
  [
    define(
      "search_people",
      "Search contacts and, on request, staged roster entries. Matches names, organization, title, notes, and tags.",
      false,
      obj(
        {
          query: str("Search text. Treated as literal text, never as query syntax."),
          scope: enumOf(["contacts", "roster", "all"], "Which records to search. Defaults to contacts."),
          include_archived: bool("Include archived people. Defaults to false."),
          limit: int("Maximum results, 1 to 50. Defaults to 20."),
        },
        ["query"]
      ),
      searchPeople
    ),
    define(
      "get_person",
      "Fetch one person with contacts, links, tags, provenance, open follow-ups, and recent encounters.",
      false,
      obj(
        {
          person_id: personId,
          encounter_limit: int("How many recent encounters to include. Defaults to 10."),
          encounter_cursor: str("Page token from a previous encounter_next_cursor."),
        },
        ["person_id"]
      ),
      getPerson
    ),
    define(
      "list_encounters",
      "List encounters by person, event, or date range, newest first.",
      false,
      obj({
        person_id: personId,
        event: str("Event name to filter by."),
        since: str("Earliest occurred_on, as YYYY-MM-DD."),
        until: str("Latest occurred_on, as YYYY-MM-DD."),
        limit: int("Page size, 1 to 100. Defaults to 20."),
        cursor: str("Page token from a previous next_cursor."),
      }),
      listEncounters
    ),
    define(
      "list_due",
      "List open follow-ups, most overdue first, in the owner's time zone.",
      false,
      obj({
        through: str("Include follow-ups due on or before this YYYY-MM-DD. Defaults to today."),
        limit: int("Page size. Defaults to 50."),
      }),
      listDue
    ),
    define(
      "list_roster_sources",
      "List imported rosters with entry, promoted, and retired counts.",
      false,
      obj({}),
      listRosterSources
    ),
    define(
      "export_data",
      "Return durable records a page at a time. Not a backup: see the deploy documentation for that.",
      false,
      obj({
        scope: enumOf(["people", "encounters", "followups"], "Which records to export. Defaults to people."),
        limit: int("Page size, 1 to 500. Defaults to 100."),
        cursor: str("Page token from a previous next_cursor."),
      }),
      exportData
    ),

    define(
      "create_person",
      "Create a person. Never matches on name; two people may share one.",
      false,
      obj(personFields, ["full_name"], { idempotent: true }),
      createPerson
    ),
    define(
      "update_person",
      "Update a person by explicit id. Only the fields provided change.",
      false,
      obj({ person_id: personId, ...personFields }, ["person_id"], { idempotent: true }),
      updatePerson
    ),
    define(
      "archive_person",
      "Archive a person, hiding them from search without deleting anything.",
      false,
      obj({ person_id: personId }, ["person_id"], { idempotent: true }),
      archivePerson
    ),
    define(
      "unarchive_person",
      "Restore an archived person.",
      false,
      obj({ person_id: personId }, ["person_id"], { idempotent: true }),
      unarchivePerson
    ),
    define(
      "delete_person",
      "Permanently delete a person and everything attached. Call once for a preview and token, again with the token to commit.",
      true,
      obj(
        {
          person_id: personId,
          confirmation_token: str("Token from the preview call. Omit on the first call."),
        },
        ["person_id"],
        { idempotent: true }
      ),
      deletePerson
    ),

    define(
      "add_contact",
      "Add an email address or phone number to a person.",
      false,
      obj(
        {
          person_id: personId,
          contact_type: enumOf(["email", "phone"], "Which kind of contact method."),
          value: str("The address or number."),
          label: nullableStr("Optional label, such as work or personal."),
        },
        ["person_id", "contact_type", "value"],
        { idempotent: true }
      ),
      addContact
    ),
    define(
      "remove_contact",
      "Remove a contact method by its prefixed id.",
      false,
      obj({ person_id: personId, contact_id: id("pc", "Contact") }, ["person_id", "contact_id"], {
        idempotent: true,
      }),
      removeContact
    ),
    define(
      "add_link",
      "Add a website or social profile to a person.",
      false,
      obj(
        {
          person_id: personId,
          link_type: str("What kind of link, such as website, mastodon, or linkedin."),
          url: str("The URL."),
        },
        ["person_id", "link_type", "url"],
        { idempotent: true }
      ),
      addLink
    ),
    define(
      "remove_link",
      "Remove a link by its prefixed id.",
      false,
      obj({ person_id: personId, link_id: id("pl", "Link") }, ["person_id", "link_id"], {
        idempotent: true,
      }),
      removeLink
    ),
    define(
      "set_tags",
      "Replace the whole tag set for a person. Pass an empty array to clear it.",
      false,
      obj({ person_id: personId, tags: strArray("The complete tag set.") }, ["person_id", "tags"], {
        idempotent: true,
      }),
      setTags
    ),

    define(
      "log_encounter",
      "Record a conversation with someone. Defaults to today in the owner's time zone.",
      false,
      obj(
        {
          person_id: personId,
          summary: str("What happened, in the user's words."),
          occurred_on: str("Local date as YYYY-MM-DD. Defaults to today."),
          occurred_at: nullableStr("Exact UTC instant, if known."),
          location: nullableStr("Where it happened."),
          event: nullableStr("Event name, such as WCUS 2026."),
        },
        ["person_id", "summary"],
        { idempotent: true }
      ),
      logEncounter
    ),
    define(
      "update_encounter",
      "Correct a mis-logged encounter.",
      false,
      obj(
        {
          encounter_id: id("enc", "Encounter"),
          summary: str("Replacement summary."),
          occurred_on: str("Replacement local date as YYYY-MM-DD."),
          location: nullableStr("Replacement location."),
          event: nullableStr("Replacement event name."),
        },
        ["encounter_id"],
        { idempotent: true }
      ),
      updateEncounter
    ),
    define(
      "delete_encounter",
      "Delete a mis-logged encounter. One call, because the point is to erase a mistake.",
      true,
      obj({ encounter_id: id("enc", "Encounter") }, ["encounter_id"], { idempotent: true }),
      deleteEncounter
    ),

    define(
      "set_followup",
      "Record what is owed to someone and when it is due.",
      false,
      obj(
        {
          person_id: personId,
          due_on: str("Local due date as YYYY-MM-DD, interpreted in the owner's time zone."),
          note: nullableStr("What is owed."),
        },
        ["person_id", "due_on"],
        { idempotent: true }
      ),
      setFollowup
    ),
    define(
      "complete_followup",
      "Close out a follow-up that has been done.",
      false,
      obj({ followup_id: id("fu", "Follow-up") }, ["followup_id"], { idempotent: true }),
      completeFollowup
    ),
    define(
      "cancel_followup",
      "Drop a follow-up without completing it.",
      false,
      obj({ followup_id: id("fu", "Follow-up") }, ["followup_id"], { idempotent: true }),
      cancelFollowup
    ),

    define(
      "import_roster",
      "Import roster rows. Resumable: call again with run_id and cursor until next_cursor is null.",
      false,
      obj(
        {
          source_key: str("Stable key for this roster, such as wcus-2026."),
          label: str("Human-readable roster name."),
          source_url: str("Where the roster came from."),
          format: enumOf(["csv", "json", "text"], "Format the rows were parsed from."),
          rows: {
            type: "array",
            description: "Every row of the roster. The server slices this and reports a cursor.",
            items: {
              type: "object",
              properties: {
                external_row_key: { type: "string" },
                full_name: { type: "string" },
                preferred_name: { type: "string" },
                job_title: { type: "string" },
                organization: { type: "string" },
                email: { type: "string" },
                role: { type: "string" },
              },
              required: ["full_name"],
            },
          },
          event: str("Event this roster belongs to."),
          run_id: id("ir", "Import run"),
          cursor: str("Offset from a previous next_cursor."),
        },
        ["source_key", "label", "source_url", "format", "rows"],
        { idempotent: true }
      ),
      importRoster
    ),
    define(
      "finalize_import",
      "Close an import run. With full_coverage, rows the run did not see are retired.",
      false,
      obj(
        {
          run_id: id("ir", "Import run"),
          full_coverage: bool("True only if the rows imported were the complete roster."),
        },
        ["run_id", "full_coverage"],
        { idempotent: true }
      ),
      finalizeImport
    ),
    define(
      "promote",
      "Promote a roster entry to a person. Call once to see duplicate candidates, again to commit.",
      false,
      obj(
        {
          roster_entry_id: id("re", "Roster entry"),
          link_to_person_id: personId,
          create_new: bool("Create a new person instead of linking to an existing one."),
        },
        ["roster_entry_id"],
        { idempotent: true }
      ),
      promote
    ),
    define(
      "purge_roster_source",
      "Delete a staged roster and its entries. Promoted people keep their provenance. Two calls: preview, then confirm.",
      true,
      obj(
        {
          roster_source_id: id("rs", "Roster source"),
          confirmation_token: str("Token from the preview call. Omit on the first call."),
        },
        ["roster_source_id"],
        { idempotent: true }
      ),
      purgeRosterSource
    ),
  ].map((tool) => [tool.name, tool])
);

/** Every tool name, so a caller can assert coverage without reaching into the map. */
export const TOOL_NAMES = Object.keys(TOOLS);
```

- [ ] **Step 3: Write the failing test `tests/contract.test.ts`**

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

const EXPECTED = [
  "add_contact",
  "add_link",
  "archive_person",
  "cancel_followup",
  "complete_followup",
  "create_person",
  "delete_encounter",
  "delete_person",
  "export_data",
  "finalize_import",
  "get_person",
  "import_roster",
  "list_due",
  "list_encounters",
  "list_roster_sources",
  "log_encounter",
  "promote",
  "purge_roster_source",
  "remove_contact",
  "remove_link",
  "search_people",
  "set_followup",
  "set_tags",
  "unarchive_person",
  "update_encounter",
  "update_person",
];

describe("tool registry", () => {
  it("exposes exactly the expected tools, in both directions", () => {
    expect(Object.keys(TOOLS).sort()).toEqual(EXPECTED);
  });

  it("names every tool consistently with its registry key", () => {
    for (const [key, tool] of Object.entries(TOOLS)) {
      expect(tool.name).toBe(key);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("gives every tool a usable input schema", () => {
    for (const tool of Object.values(TOOLS)) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      for (const field of tool.inputSchema.required ?? []) {
        expect(
          Object.keys(tool.inputSchema.properties),
          `${tool.name} requires ${field} but does not declare it`
        ).toContain(field);
      }
      for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
        expect((schema as { description?: string }).description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("declares idempotency_key on every write", () => {
    const writes = EXPECTED.filter(
      (name) => !name.startsWith("list_") && !name.startsWith("search_") &&
        name !== "get_person" && name !== "export_data"
    );
    for (const name of writes) {
      const tool = TOOLS[name];
      expect(
        Object.keys(tool?.inputSchema.properties ?? {}),
        `${name} does not accept an idempotency_key`
      ).toContain("idempotency_key");
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
      ["unarchive_person", { person_id: newId("enc") }],
      ["delete_person", { person_id: newId("re") }],
      ["add_contact", { person_id: newId("re"), contact_type: "email", value: "a@example.test" }],
      ["remove_contact", { person_id: newId("re"), contact_id: newId("pc") }],
      ["add_link", { person_id: newId("re"), link_type: "website", url: "https://example.test" }],
      ["remove_link", { person_id: newId("re"), link_id: newId("pl") }],
      ["set_tags", { person_id: newId("re"), tags: [] }],
      ["log_encounter", { person_id: newId("re"), summary: "x" }],
      ["update_encounter", { encounter_id: newId("p"), summary: "x" }],
      ["delete_encounter", { encounter_id: newId("p") }],
      ["set_followup", { person_id: newId("re"), due_on: "2026-08-25" }],
      ["complete_followup", { followup_id: newId("p") }],
      ["cancel_followup", { followup_id: newId("p") }],
      ["finalize_import", { run_id: newId("rs"), full_coverage: false }],
      ["promote", { roster_entry_id: newId("p") }],
      ["purge_roster_source", { roster_source_id: newId("p") }],
    ];

    for (const [name, input] of wrongKind) {
      const tool = TOOLS[name];
      if (!tool) throw new Error(`no tool ${name}`);
      await expect(tool.run(ctx, input as never), `${name} accepted a wrong-kind id`).rejects.toThrow(
        ToolError
      );
    }
  });
});
```

The first test asserts equality against a sorted list rather than checking that a handful of names are present. The first draft looped over twenty names and asserted each was defined, which passes while `unarchive_person`, `remove_contact`, `add_link`, `remove_link`, and `finalize_import` are missing from the registry entirely. Equality in both directions is the only version of this test that can fail for the right reason, and it fails loudly when a tool is added without being listed here.

The wrong-kind id table covers every tool that takes an id, not a sample. That test is the plan's single most important one: it proves the id-prefix discipline holds across the whole surface rather than where someone remembered it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/schema.ts src/tools/index.ts tests/contract.test.ts
git commit -m "feat: add the tool registry with input schemas and contract tests"
```

---

### Task 17: The end-to-end path over a committed fixture

**Files:**
- Create: `tests/fixtures/roster.csv`
- Test: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: the registry from Task 16. This task calls tools through `TOOLS`, not through their modules, because that is how plan 2 will call them.

The spec asks for one end-to-end path over a small committed fixture: import a roster, promote a person, log an encounter, set a follow-up, list what is due. Every individual step is already tested. This proves they compose, which is a different claim, and it is the test that would have caught an interface disagreement between two tasks written by two agents on two different days.

The fixture is invented data, not an extract of anyone's real roster. It includes two people who share a name, because that is the case the whole import identity design exists for.

- [ ] **Step 1: Write `tests/fixtures/roster.csv`**

```
external_row_key,full_name,job_title,organization,email,role
1,Ada Lovelace,Engineer,Analytical Engines,ada@example.test,attendee
2,Grace Hopper,Rear Admiral,US Navy,grace@example.test,speaker
3,Chris Smith,Designer,Studio A,chris.a@example.test,attendee
4,Chris Smith,Developer,Studio B,chris.b@example.test,attendee
```

- [ ] **Step 2: Declare the raw-text import in `env.d.ts`**

Append:

```ts
declare module "*.csv?raw" {
  const content: string;
  export default content;
}
```

Without it `npm run typecheck` fails on the fixture import, which is a confusing way to learn that a test file is fine.

- [ ] **Step 3: Write `tests/e2e.test.ts`**

```ts
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/context";
import { parseCsv } from "../src/tools/import_state";
import { TOOLS } from "../src/tools/index";
// Vite's ?raw import inlines the fixture at build time. Tests run inside workerd,
// which has no filesystem, so node:fs is not an option here.
import csv from "./fixtures/roster.csv?raw";

let now = new Date("2026-08-20T12:00:00Z");
const ctx: ToolContext = {
  db: env.DB,
  timezone: "America/Los_Angeles",
  clock: () => now,
};

function call(name: string, input: unknown): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(ctx, input as never);
}

beforeEach(async () => {
  now = new Date("2026-08-20T12:00:00Z");
  await env.DB.prepare("DELETE FROM roster_sources").run();
  await env.DB.prepare("DELETE FROM people").run();
});

describe("the conference path", () => {
  it("imports a roster, promotes someone, logs an encounter, and surfaces what is owed", async () => {
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(4);

    const imported = (await call("import_roster", {
      source_key: "wcus-2026",
      label: "WordCamp US 2026",
      event: "WCUS 2026",
      source_url: "https://example.test/attendees",
      format: "csv",
      rows,
    })) as { run_id: string; imported: number; next_cursor: string | null };

    expect(imported.imported).toBe(4);
    expect(imported.next_cursor).toBeNull();

    await call("finalize_import", { run_id: imported.run_id, full_coverage: true });

    // Find the roster entry the way an agent would.
    const found = (await call("search_people", { query: "Hopper", scope: "roster" })) as {
      results: { id: string; record_kind: string }[];
    };
    expect(found.results).toHaveLength(1);
    const entryId = found.results[0]?.id ?? "";
    expect(entryId).toMatch(/^re_/);

    // Phase one: candidates, no writes.
    const candidates = (await call("promote", { roster_entry_id: entryId })) as {
      status: string;
      candidates: unknown[];
    };
    expect(candidates.status).toBe("candidates");
    expect(candidates.candidates).toEqual([]);

    // Phase two: commit.
    const promoted = (await call("promote", {
      roster_entry_id: entryId,
      create_new: true,
    })) as { status: string; person: { id: string; contacts: { value: string }[] } };
    expect(promoted.status).toBe("promoted");
    const personId = promoted.person.id;
    expect(promoted.person.contacts[0]?.value).toBe("grace@example.test");

    await call("log_encounter", {
      person_id: personId,
      summary: "Hallway track, talked about compilers.",
      event: "WCUS 2026",
      location: "Portland",
    });

    await call("set_followup", {
      person_id: personId,
      due_on: "2026-08-19",
      note: "Send the deck.",
    });

    const due = (await call("list_due", {})) as {
      results: { person_name: string; days_overdue: number }[];
      as_of: string;
    };
    expect(due.as_of).toBe("2026-08-20");
    expect(due.results).toHaveLength(1);
    expect(due.results[0]?.person_name).toBe("Grace Hopper");
    expect(due.results[0]?.days_overdue).toBe(1);

    const detail = (await call("get_person", { person_id: personId })) as {
      encounter_count: number;
      open_followups: unknown[];
      sources: { source_key: string }[];
      tags: string[];
    };
    expect(detail.encounter_count).toBe(1);
    expect(detail.open_followups).toHaveLength(1);
    expect(detail.sources[0]?.source_key).toBe("wcus-2026");
  });

  it("keeps two people who share a name separate through import and promotion", async () => {
    const rows = parseCsv(csv);

    const imported = (await call("import_roster", {
      source_key: "wcus-2026",
      label: "WordCamp US 2026",
      source_url: "https://example.test/attendees",
      format: "csv",
      rows,
    })) as { run_id: string };
    await call("finalize_import", { run_id: imported.run_id, full_coverage: true });

    const found = (await call("search_people", { query: "Chris Smith", scope: "roster" })) as {
      results: { id: string }[];
    };
    expect(found.results).toHaveLength(2);

    for (const hit of found.results) {
      await call("promote", { roster_entry_id: hit.id, create_new: true });
    }

    const people = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>();
    expect(people?.n).toBe(2);

    const orgs = await env.DB.prepare(
      "SELECT organization FROM people ORDER BY organization"
    ).all<{ organization: string }>();
    expect(orgs.results.map((r) => r.organization)).toEqual(["Studio A", "Studio B"]);
  });
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run tests/e2e.test.ts`
Expected: PASS, both cases. If either fails, the failure is an interface disagreement between tasks rather than a bug inside one of them, and it is worth reading as such.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors, no skipped tests.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/roster.csv tests/e2e.test.ts env.d.ts
git commit -m "test: add the end-to-end conference path over a committed fixture"
```

---

## Verification

Run once every task is complete. Nothing here is optional.

- [ ] **Full suite green:** `npm test` passes with no skipped tests.
- [ ] **Types clean:** `npm run typecheck` reports no errors.
- [ ] **Migrations apply to a real local D1, not just the test harness:** `npx wrangler d1 migrations apply junco-prm --local`, then `npx wrangler d1 execute junco-prm --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`. The FTS triggers are the thing being checked; the test harness and Wrangler apply migrations by different code paths, and only the second is what a deployment runs.
- [ ] **Every trigger exists, not just the tables:** `npx wrangler d1 execute junco-prm --local --command "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"` lists all six: `people_fts_ai`, `people_fts_ad`, `people_fts_au`, `encounters_fts_ai`, `encounters_fts_ad`, `encounters_fts_au`. A half-applied trigger set is the failure mode this checks for, and it is silent everywhere else.
- [ ] **No external-content FTS survived the revision:** `grep -rn "content_rowid\|content='" migrations/` returns nothing.
- [ ] **No per-row writes survived the revision:** `grep -rn "\.run()" src/tools/import.ts` shows no call inside a `for` loop. Every roster write goes through `db.batch()`.
- [ ] **No dynamic imports:** `grep -rn "await import(" src/` returns nothing. The `_read` modules exist so the import graph is static.
- [ ] **No PRM content in logs:** `grep -rn "console\." src/` returns nothing, or only lines carrying tool name, duration, outcome, and identifiers.
- [ ] **Every tool reachable through the registry with a schema:** `tests/contract.test.ts` passes, including the both-directions name equality.
- [ ] **The whole path composes:** `tests/e2e.test.ts` passes.

## What this plan does not build

Named so a reviewer does not read the absence as an oversight.

- No HTTP, no MCP, no OAuth, no `/health`. Plan 2.
- No CLI export and no restore drill. Plan 3. `export_data` in Task 15 is a convenience read, not a backup, and the spec says so explicitly.
- No merge tool. The spec defers it until there is real duplicate data to design against, and `promote` surfaces candidates without resolving them.
- No rate limiting. It belongs on the unauthenticated OAuth routes, which do not exist until plan 2.
- No scheduled export. It is an open question in the spec, because where the export writes is undecided.
- No import at the WCUS prototype's 798-row scale. The spec holds that back as a separate scale test, run once the fixture path in Task 17 is proven.

## Decisions taken on review

Four questions came out of the 2026-08-21 review that the plan could not settle on its own. Recorded with their reasoning, because each one is a place where a later reader will otherwise wonder what was considered.

- **FTS5 indexes are standalone tables carrying the record id as an `UNINDEXED` column,** not external-content tables. One reviewer called `content_rowid='rowid'` against a `TEXT PRIMARY KEY` fatal, on the grounds that `VACUUM` can renumber the implicit rowids; two called it fine. SQLite does document that rowid renumbering, so the mechanism is real even though D1's maintenance behavior is not documented either way. The alternative, adding an integer surrogate key to `people` and `encounters` to stabilize the rowid, was considered and rejected: it buys back a few megabytes of duplicated text at the cost of a second key on every durable row. The failure being designed against is silent, which is what settled it.
- **The test harness stays `@cloudflare/vitest-pool-workers` 0.22.** Cloudflare's current documentation shows `@cloudflare/vitest-plugin` and `cloudflareTest()`, and one reviewer flagged the pool package as obsolete on that basis. The plugin was first published on 2026-08-20 and is one release old; the pool package is not deprecated, was updated on 2026-08-18, and targets the same Vitest 4.1. An executing agent that searches the docs will find the newer shape, which is why Task 1 says explicitly not to substitute it.
- **`export_data` is built here, in Task 15.** The spec kept it in the tool surface and the first draft of this plan listed it under what it does not build. The spec wins: it is a read over tables this plan already owns, and plan 3's CLI export is a different interface for a different job.
- **`delete_encounter` stays a single call.** It is the one destructive operation outside the two-call rule, and Global Constraints now states the exception rather than leaving the plan contradicting itself. An encounter is one row the user just dictated, `update_encounter` handles most corrections, and Time Travel covers a delete they regret.

## Open question for the spec, not for this plan

`import_roster` takes the entire `rows` array on every call and slices it server-side, per the spec's tool contract, so a 798-row roster is re-sent by the agent on each of six calls. That is what makes the run's input hash checkable and the cursor meaningful, and it is a lot of tokens to spend re-transmitting rows the server already has.

The alternative is a protocol where each call carries only its own chunk plus a declared `expected_total`, and the run's identity comes from the run id rather than from a hash of the whole input. It is cheaper and it weakens the continuation checks that Task 12a exists to provide.

This plan implements the spec as written rather than quietly changing the contract. It is worth deciding before plan 2 pins the tool surface into an MCP schema.
