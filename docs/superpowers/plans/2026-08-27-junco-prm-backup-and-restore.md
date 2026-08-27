# Junco PRM Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Junco PRM a backup that has actually been restored, covering both the seven-day window and the loss of the Cloudflare account.

**Architecture:** Two layers. D1 Time Travel needs no artifact and covers recent damage; it is verified and documented, not built. A local Node script uses `wrangler d1 execute --remote --json` to read each durable table by name, which sidesteps the virtual-table restriction that makes `wrangler d1 export` unusable here, and writes a checksummed JSON archive. A companion script restores that archive into a disposable database and rebuilds the FTS indexes by reinsertion.

**Tech Stack:** Node 26 ESM (`.mjs`, no build step), wrangler 4.125.0, vitest 4.1.11 with a second test project for Node-environment tests, `bzip2` from the shell.

**Spec:** `docs/superpowers/specs/2026-08-27-junco-prm-read-surface-and-export-design.md` (phases P0 and P1)

## Revised 2026-08-27 after a four-agent code review

Ten defects, all verified against the repository or wrangler's own bundled
source before being accepted. Recorded because two of them made the plan
unexecutable and because two confident review findings were wrong.

**Blocking.** `wrangler d1 migrations apply` resolves a database only from
`wrangler.jsonc`, unlike `d1 execute`, which falls back to the API. Task 8
created the drill database but never added it to the config, so the restore
died on its first wrangler call, every time, in the task the whole plan exists
to reach. Task 8 Step 1 now adds the entry and Step 6 removes it.

**Blocking.** Task 8 Step 5 queried `people_fts.record_id`. Migration 0004
declares the column as `id`. The plan calls that step the one most likely to
fail and tells the implementer to read a failure as evidence the triggers did
not fire, so they would have debugged the wrong thing.

**The verification was circular.** The manifest counted whatever the export
returned, and the drill compared the restore against that manifest. A stray
`LIMIT 100` would have passed every test in this plan. The export now asks the
database for independent counts and aborts on a mismatch, and Step 4 diffs the
restored database against the live one across all eleven tables rather than
the eight it previously listed while claiming every count matched.

**`verifyManifest` blessed archives missing whole tables**, because the
manifest is built from the payload and can only describe what is present. It
now checks the table set against the inventory, so the archive is
self-describing at recovery time on a machine without this repository.

**The compressed artifact was not atomic.** The JSON was renamed into place and
compressed there, so an interrupted `bzip2` left a truncated file under the
name of a trusted backup. Compression and integrity checking now happen under
a temporary name. Filenames carry minutes, because a date-only name plus
`bzip2 -f` meant the second export of a day destroyed the first.

**The restore had no target guard.** `npm run restore -- backup.bz2 junco-prm`
would have merged the archive into production. It now refuses a non-empty
target at all. (Round two removed the `--force` escape hatch this originally carried; see below.)

**A declined prompt read as success.** Remote `--file` warns and prompts on a
TTY; declining returns null and exits 0, and the script printed "Restore
complete" over a database that received nothing. It now passes `--yes` and
verifies row counts before claiming anything.

**Task 2's smoke test would have passed before the change it was meant to
fail against**, because `nodejs_compat` gives workerd `node:crypto`. It now
spawns a child process, which workerd genuinely cannot do.

**Three smaller ones:** the ordering test never asserted `import_runs` before
`roster_entries` despite two real foreign keys; `parseExecuteJson` matched the
`[` in a `[WARNING]` banner; and the restore SQL was written to the repository
root in plaintext rather than the temp directory.

### Two review findings rejected, with the evidence

**`test.projects` is correct.** One reviewer called it Jest syntax that vitest
silently ignores, which would have dropped the Workers pool and destroyed 475
tests. `projects?: TestProjectConfiguration` is in vitest 4.1.11's own type
definitions and `workspace` no longer exists. Two other reviewers confirmed it
independently.

**The 100 KB per-statement and 30 s query limits do not apply to `--file`.**
Two reviewers built findings on them, one recommending explicit transactions
and one predicting that a large `raw_record` would fail on restore. Wrangler's
bundled source shows `--file` never sends statements: it uploads to R2 and
calls D1's `import` endpoint, which is why it prints "if the execution fails to
complete, your DB will return to its original state". Thousands of INSERTs in
one file is the supported path.

**One assumption was confirmed rather than corrected.** A reviewer loaded all
eight migrations into in-memory SQLite and inserted a person and an encounter;
both FTS tables received a row through their triggers. The riskiest bet in this
plan holds.

**This is plan 1 of 3.** Plan 2 covers the documentation corrections and argument validation (spec P2 and P3). Plan 3 covers the read surface and `update_followup` (spec P4 and P5). This plan touches no Worker code and requires no migration, which is why it goes first: everything in plans 2 and 3 modifies a live database that currently has no backup.

### Revised again, same day, after a second review of the revision

The second round found that the first round's own fixes introduced a blocking
defect and left three gaps. Recorded because "the fix broke something" is the
failure this project keeps producing.

**The revision broke Task 8.** Making export filenames minute-precise, to stop
a second export destroying the first, left Step 3 still opening
`junco-backup-$(date +%F).json.bz2`. Two reviewers caught it independently.
Step 3 now uses the newest matching file. This is exactly the class of defect
the first round was praised for finding and the revision then committed.

**The restore mutated a mistyped target before refusing it.** The emptiness
check ran after `migrations apply`, so pointing it at the wrong database
created Junco's schema there and only then declined. The check now runs first,
treating "no such table" as the signal for a fresh database, which is the only
error it tolerates.

**`--force` is gone.** It let the operator merge an archive into a populated
database, which duplicates every row whose id does not collide and reports
success. There is no flag for that now, and the refusal says why.

**The 100 KB statement limit is no longer something this plan has to be right
about.** Round one rejected it on the grounds that `--file` uses D1's import
path; round two argued D1 still documents a per-statement limit that the
import path must also honour. That dispute is unresolved and could not be
settled here, so `insertStatements` now refuses to generate a statement over
90 KB and says which row caused it. A row that cannot be restored is found at
export time rather than during a recovery.

**Two smaller ones.** Task 2 Step 3 predicted the wrong failure: vitest's
default glob does match `*.test.mjs`, so the file is collected and fails in the
Workers pool rather than going uncollected. And the drill compared row counts
only, so identical counts with different content passed; it now re-exports from
the restored database and diffs the manifests, which is content equality.

**Round two also confirmed** the `readRaw` chain, the inventory check in
`verifyManifest`, the FTS column fix, the temporary config entry, and that
`test.projects` is correct vitest 4.

**One agent returned nothing.** claude-opus timed out at 540 seconds with no
output. It completed the previous round in 529 seconds against a 1,339 line
plan; this plan is now 1,725 lines. The margin was the plan's growth, not a
fault. A third review of this document should either target a smaller slice or
accept that one reviewer will not finish.

## Global Constraints

- **No em dashes or en dashes anywhere**, in code, comments, docs, or commit messages. Plain hyphens only.
- **No `console` calls in `src/`.** A repository-wide test enforces this. This plan adds no `src/` code, but `scripts/` is exempt and is where all output goes.
- **The Worker's `tsconfig.json` must not gain `@types/node`.** It declares Workers types only. Scripts are plain JavaScript for this reason; adding Node types would weaken typechecking on the Worker.
- **Never commit real Cloudflare resource ids.** `wrangler.jsonc` is gitignored; `wrangler.example.jsonc` is the template. Archives are gitignored too.
- **The 475 existing tests must keep passing** after every task. `npm test` is the gate.
- **The archive contains personal data.** Restrictive file permissions (`0o600`) are a requirement, not a nicety.
- **FTS5 tables are never read and never written by these scripts.** They are derived data. On restore they are repopulated by reinserting source rows so existing triggers fire.

---

## File Structure

**Created by this plan:**

- `scripts/lib/inventory.mjs` - the table inventory: which tables exist, which are backed up, which are excluded and why, and the order they must be restored in. Pure data plus one classification function.
- `scripts/lib/inventory.test.mjs` - proves the inventory matches the migrations on disk, so a future migration cannot silently escape the backup.
- `scripts/lib/manifest.mjs` - builds and verifies the archive manifest: counts, checksums, versions.
- `scripts/lib/manifest.test.mjs`
- `scripts/lib/d1.mjs` - the only module that shells out to `wrangler`. Takes an injectable runner so everything above it is testable without a network.
- `scripts/lib/d1.test.mjs`
- `scripts/export.mjs` - the operator-facing export entry point.
- `scripts/restore.mjs` - the operator-facing restore entry point.
- `docs/BACKUP.md` - the runbook: Time Travel, the export, the restore, and the cadence.

**Modified:**

- `vitest.config.ts` - gains a second test project so Node-environment tests can run beside the Workers-pool tests.
- `.gitignore` - archives must never be committed.
- `package.json` - `export` and `restore` scripts.
- `docs/MEASUREMENTS.md` - records what Time Travel and `wrangler d1 execute --json` actually returned.

---

### Task 1: Time Travel, verified and written down

No code. This is the layer that protects the data today and it needs no artifact, so it ships before anything is built.

**Files:**
- Create: `docs/BACKUP.md`
- Modify: `docs/MEASUREMENTS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/BACKUP.md` with a `## Time Travel` section. Later tasks append to this file.

- [ ] **Step 1: Record what Time Travel actually reports**

This is an operator step. Run it and paste the real output into the next step; do not paraphrase it.

```bash
npx wrangler d1 time-travel info junco-prm
```

Expected: a bookmark and a timestamp. If it errors, record the error verbatim. The spec lists "whether the live database is on a backend that supports Time Travel" as an open question, and this command is what closes it.

- [ ] **Step 2: Append the result to `docs/MEASUREMENTS.md`**

Add a section in the style of the existing entries, carrying the date, the wrangler version, the exact command, and the verbatim output. Follow the file's existing heading convention.

- [ ] **Step 3: Write `docs/BACKUP.md`**

```markdown
# Backing up Junco PRM

Two layers, covering different failures. Reach for the right one.

| Failure | Layer | Cost to recover |
|---|---|---|
| A bad write or a bad migration in the last 7 days | Time Travel | One command, no artifact needed |
| Database deleted, account lost, or damage older than 7 days | The JSON archive | Whatever the last export captured |

## Time Travel

D1 keeps point-in-time history automatically. Retention is 7 days on the
free plan and 30 days on paid. Nothing needs to be set up and nothing
needs to be remembered in advance.

Check what is available:

    npx wrangler d1 time-travel info junco-prm

Restore to a point in time:

    npx wrangler d1 time-travel restore junco-prm --timestamp <ISO timestamp>

**Restore is destructive and happens in place.** It replaces the current
database. There is no undo beyond restoring forward to a later bookmark,
and only within the retention window.

### Before every migration and every deploy

Record a bookmark first:

    npx wrangler d1 time-travel info junco-prm

Paste the bookmark into the deploy note for that change. If the deploy
goes wrong, that bookmark is the fastest way back and it costs one
command to capture.

### What Time Travel does not cover

Account loss, database deletion, and anything older than the retention
window. That is what the archive is for, and it is the reason the archive
exists at all.
```

- [ ] **Step 4: Commit**

```bash
git add docs/BACKUP.md docs/MEASUREMENTS.md
git commit -m "docs: verify and document D1 Time Travel as the short-term recovery layer"
```

---

### Task 2: A second test project, so Node scripts can be tested at all

`vitest.config.ts` currently runs the entire suite in the Workers pool. Code running there cannot spawn `wrangler`, read the filesystem, or use `node:crypto` the way a CLI does. Everything else in this plan is untestable until this exists.

**Files:**
- Modify: `vitest.config.ts`
- Create: `scripts/lib/smoke.test.mjs` (temporary, deleted in Task 3)

**Interfaces:**
- Consumes: nothing.
- Produces: a vitest project named `scripts` that runs `scripts/**/*.test.mjs` in the Node environment. Every later task's tests live there.

- [ ] **Step 1: Confirm the projects syntax against the installed vitest**

Do not trust this plan's syntax without checking; vitest changed this API across major versions and the installed version is 4.1.11.

```bash
npx vitest --help | grep -i project
```

If `projects` is not supported as written below, consult `node_modules/vitest/package.json` for the version and adjust to that version's documented shape. Record what you used.

- [ ] **Step 2: Write the temporary smoke test**

```javascript
// scripts/lib/smoke.test.mjs
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("the scripts test project", () => {
  // Spawning a process is the capability these scripts actually need and the
  // one workerd genuinely cannot provide. An earlier draft of this test used
  // node:crypto, which would have PASSED before the config change: this
  // Worker sets nodejs_compat and Cloudflare supports node:crypto, so the
  // "watch it fail" step would have failed to fail.
  it("can spawn a child process", async () => {
    const { stdout } = await execFileAsync("node", ["-e", "process.stdout.write('ok')"]);
    expect(stdout).toBe("ok");
  });

  // Fails if the project's `include` is wrong and this file was picked up by
  // the workers project instead.
  it("has a real Node process with a version", () => {
    expect(process.versions.node).toMatch(/^\d+\./);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run scripts/lib/smoke.test.mjs`

Expected: FAIL, because the file runs in the Workers pool. Vitest's default
glob does match `*.test.mjs`, so the file IS collected; the current config
applies `cloudflareTest` to everything it collects, and workerd cannot spawn
a child process.

If it passes, stop. The configuration is not what this task assumes and the
rest of the task is built on a wrong premise.

- [ ] **Step 4: Restructure `vitest.config.ts` into two projects**

The existing Workers configuration moves inside a project entry unchanged. Nothing about it is altered; it only becomes nested.

```typescript
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  test: {
    projects: [
      {
        // The Worker suite, unchanged. Everything here was previously at the
        // top level of this file and behaves identically; it is nested only
        // so a second project can exist beside it.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.example.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                // Test-only. Never real credentials - this file is committed,
                // and a secret in it is a secret in the repository forever.
                GITHUB_CLIENT_ID: "Iv1.test-client-id",
                GITHUB_CLIENT_SECRET: "test-client-secret",
                COOKIE_ENCRYPTION_KEY: "0".repeat(64),
                OWNER_GITHUB_USER_ID: "583231",
                OWNER_TIMEZONE: "UTC",
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/**/*.test.ts"],
          setupFiles: ["./tests/apply-migrations.ts"],
          isolate: false,
          maxWorkers: 1,
          sequence: { groupOrder: 0 },
        },
      },
      {
        // The backup and restore scripts. Plain Node, because they shell out
        // to wrangler and touch the filesystem, neither of which workerd can
        // do. Kept out of the Worker's tsconfig for the same reason.
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/**/*.test.mjs"],
          // Two projects with different maxWorkers must also declare different
          // group orders, or vitest 4.1.11 refuses to run and reports zero
          // tests. Found by running Step 6; it does not appear in --help or in
          // the type definitions, only when both projects execute together.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
```

- [ ] **Step 5: Run the smoke test and watch it pass**

Run: `npx vitest run --project scripts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Prove the Worker suite is undamaged**

This is the step that matters. The config was restructured underneath 475 passing tests.

Run: `npm test`
Expected: PASS, 477 tests across 38 files. That is the existing 475 plus this task's 2.

Run: `npm run typecheck`
Expected: clean. `scripts/` is `.mjs` and is not in the TypeScript project, so it must not appear in the output.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts scripts/lib/smoke.test.mjs
git commit -m "test: add a Node test project so the backup scripts can be tested"
```

---

### Task 3: The table inventory, and a test that catches the next migration

The archive is defined by which tables it contains. That list must not be maintained by memory, because the failure is silent: a future migration adds a table, nobody updates the inventory, and the archive quietly stops being complete.

**Files:**
- Create: `scripts/lib/inventory.mjs`
- Create: `scripts/lib/inventory.test.mjs`
- Delete: `scripts/lib/smoke.test.mjs`

**Interfaces:**
- Consumes: the vitest `scripts` project from Task 2.
- Produces:
  - `BACKED_UP: string[]` - table names in restore-safe order.
  - `EXCLUDED: Record<string, string>` - table name to the reason it is excluded.
  - `ALL_KNOWN: string[]` - the union, which is every table the migrations create.
  - `tablesInMigrations(dir: string): Promise<string[]>` - every table name any migration creates, including virtual tables.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/lib/inventory.test.mjs
import { describe, expect, it } from "vitest";
import { ALL_KNOWN, BACKED_UP, EXCLUDED, tablesInMigrations } from "./inventory.mjs";

describe("the table inventory", () => {
  // THE POINT OF THIS FILE. Fails when a migration adds a table and nobody
  // decides whether it belongs in the archive. Without this, the archive
  // silently stops being complete and nothing says so.
  it("classifies every table the migrations create", async () => {
    const actual = await tablesInMigrations("./migrations");
    expect([...actual].sort()).toEqual([...ALL_KNOWN].sort());
  });

  // Fails if a table is both backed up and excluded, which would mean the
  // reason string is a lie.
  it("never both backs up and excludes the same table", () => {
    const overlap = BACKED_UP.filter((t) => t in EXCLUDED);
    expect(overlap).toEqual([]);
  });

  // Fails if a parent is restored after its child. Restoring person_contacts
  // before people violates the foreign key and the restore aborts partway,
  // which is the worst moment to discover an ordering mistake.
  it("orders parents before their children", () => {
    const pos = (t) => BACKED_UP.indexOf(t);
    expect(pos("people")).toBeLessThan(pos("person_contacts"));
    expect(pos("people")).toBeLessThan(pos("person_links"));
    expect(pos("people")).toBeLessThan(pos("person_tags"));
    expect(pos("tags")).toBeLessThan(pos("person_tags"));
    expect(pos("people")).toBeLessThan(pos("encounters"));
    expect(pos("people")).toBeLessThan(pos("followups"));
    expect(pos("roster_sources")).toBeLessThan(pos("import_runs"));
    expect(pos("roster_sources")).toBeLessThan(pos("roster_entries"));
    // Two real foreign keys, both easy to miss: roster_entries.last_seen_run_id
    // is NOT NULL REFERENCES import_runs(id) (migration 0002), and
    // committed_run_id references it too (migration 0008).
    expect(pos("import_runs")).toBeLessThan(pos("roster_entries"));
    expect(pos("people")).toBeLessThan(pos("person_sources"));
    expect(pos("roster_sources")).toBeLessThan(pos("person_sources"));
  });

  // Fails if an FTS5 table reaches the archive. Reading one produces the
  // index's internal shadow rows, not records, and restoring that is how a
  // backup comes back corrupt.
  it("excludes both FTS5 virtual tables with a stated reason", () => {
    expect(EXCLUDED.people_fts).toMatch(/derived/i);
    expect(EXCLUDED.encounters_fts).toMatch(/derived/i);
    expect(BACKED_UP).not.toContain("people_fts");
    expect(BACKED_UP).not.toContain("encounters_fts");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project scripts scripts/lib/inventory.test.mjs`
Expected: FAIL, "Cannot find module ./inventory.mjs".

- [ ] **Step 3: Write the inventory**

```javascript
// scripts/lib/inventory.mjs
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tables written to the archive, in an order that satisfies every foreign
 * key on restore: a table never appears before something it references.
 *
 * Operational tables are deliberately absent; see EXCLUDED for the reasons.
 */
export const BACKED_UP = [
  "people",
  "tags",
  "person_contacts",
  "person_links",
  "person_tags",
  "encounters",
  "followups",
  "roster_sources",
  "import_runs",
  "roster_entries",
  "person_sources",
];

/**
 * Every table deliberately left out, with the reason. The reason is part of
 * the data because it ends up in the archive manifest: someone restoring
 * this file in two years needs to know what is not in it and why, at the
 * moment they are reading the file rather than the repository.
 */
export const EXCLUDED = {
  people_fts:
    "Derived. An FTS5 index, rebuilt on restore by reinserting people so the existing triggers fire.",
  encounters_fts:
    "Derived. An FTS5 index, rebuilt on restore by reinserting encounters so the existing triggers fire.",
  idempotency_keys:
    "Operational. Holds stored tool responses for retry replay, expires on its own, and replaying a claim recorded before a restore is worse than not having it.",
  confirmations:
    "Operational. Short-lived tokens for two-phase destructive calls. A token issued before a restore must not survive it.",
  import_chunk_receipts:
    "Operational. Resumability for an import that was in flight. An import interrupted by the loss of the database is not resumed, it is re-run.",
};

export const ALL_KNOWN = [...BACKED_UP, ...Object.keys(EXCLUDED)];

/**
 * Every table name any migration creates, virtual tables included.
 *
 * Reads the migrations rather than the live database on purpose: the check
 * this feeds must fail in CI, before a deploy, not after someone notices the
 * archive is thin.
 */
export async function tablesInMigrations(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const names = new Set();
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    const pattern = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    for (const match of sql.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project scripts scripts/lib/inventory.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Confirm the guard test actually guards**

A test that passes and guards nothing is this project's most common defect, seventeen of them across two plans. Prove this one is real before trusting it.

Temporarily remove `"followups"` from `BACKED_UP`, then run the test file again. Expected: FAIL, on the classification test and on the ordering test. Restore the line and confirm PASS. This is a genuine behaviour change rather than a no-op, so a green suite after the mutation would have meant the test was blind.

- [ ] **Step 6: Delete the smoke test**

It existed to prove the project runs. The inventory tests now do that as a side effect.

```bash
rm scripts/lib/smoke.test.mjs
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS, 479 tests. The 475 originals plus 4 here; the 2 smoke tests are gone.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/inventory.mjs scripts/lib/inventory.test.mjs
git rm --cached scripts/lib/smoke.test.mjs 2>/dev/null || true
git add -A scripts/
git commit -m "feat: define the backup table inventory, with a test that catches new tables"
```

---

### Task 4: The manifest

An archive nobody can verify is a file, not a backup. The manifest is what makes a truncated or altered archive detectable.

**Files:**
- Create: `scripts/lib/manifest.mjs`
- Create: `scripts/lib/manifest.test.mjs`

**Interfaces:**
- Consumes: `BACKED_UP` and `EXCLUDED` from `scripts/lib/inventory.mjs`.
- Produces:
  - `checksum(rows: object[]): string` - SHA-256 hex over the canonical JSON of one table's rows.
  - `buildManifest({ tables, schemaVersion, appVersion, exportedAt }): object`
  - `verifyManifest(archive: object): { ok: boolean, problems: string[] }`

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/lib/manifest.test.mjs
import { describe, expect, it } from "vitest";
import { BACKED_UP } from "./inventory.mjs";
import { buildManifest, checksum, verifyManifest } from "./manifest.mjs";

// Every table in BACKED_UP, not just the two under test. verifyManifest
// checks the manifest's table set against the inventory, so a fixture
// carrying a subset is itself an incomplete archive and is correctly
// refused. Found during execution, when the two-table version failed
// "accepts an untampered archive" with nine missing-table problems.
const archive = (overrides = {}) => {
  const tables = Object.fromEntries(BACKED_UP.map((t) => [t, []]));
  tables.people = [{ id: "p_1", full_name: "Ada" }];
  return {
    manifest: buildManifest({
      tables,
      schemaVersion: "0008_committed_run.sql",
      appVersion: "1.0.0",
      exportedAt: "2026-08-27T12:00:00.000Z",
    }),
    tables,
    ...overrides,
  };
};

describe("checksum", () => {
  // Fails if key order in a row changes the digest. wrangler's JSON output
  // has no ordering guarantee, so an order-sensitive checksum would report
  // corruption on a perfectly good archive.
  it("is stable across key order within a row", () => {
    expect(checksum([{ a: 1, b: 2 }])).toBe(checksum([{ b: 2, a: 1 }]));
  });

  // Fails if row order is ignored. Row order is real content: it is what a
  // restore replays, so two different orders are two different archives.
  it("changes when row order changes", () => {
    expect(checksum([{ id: 1 }, { id: 2 }])).not.toBe(checksum([{ id: 2 }, { id: 1 }]));
  });

  it("changes when a value changes", () => {
    expect(checksum([{ id: 1 }])).not.toBe(checksum([{ id: 2 }]));
  });

  it("distinguishes an empty table from a missing one", () => {
    expect(checksum([])).toHaveLength(64);
  });
});

describe("buildManifest", () => {
  it("records a count and a checksum for every table", () => {
    const m = archive().manifest;
    expect(m.tables.people).toEqual({ count: 1, checksum: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(m.tables.tags).toEqual({ count: 0, checksum: expect.any(String) });
  });

  // The manifest travels with the file and is read by someone who does not
  // have this repository open. What is absent has to be stated in the file.
  it("carries the exclusion reasons so the archive explains its own gaps", () => {
    const m = archive().manifest;
    expect(m.excluded.people_fts).toMatch(/derived/i);
    expect(m.excluded.idempotency_keys).toMatch(/operational/i);
  });

  it("carries the schema version, app version, and export time", () => {
    const m = archive().manifest;
    expect(m.schema_version).toBe("0008_committed_run.sql");
    expect(m.app_version).toBe("1.0.0");
    expect(m.exported_at).toBe("2026-08-27T12:00:00.000Z");
  });
});

describe("verifyManifest", () => {
  it("accepts an untampered archive", () => {
    expect(verifyManifest(archive())).toEqual({ ok: true, problems: [] });
  });

  // The failure this whole task exists to catch: a truncated file whose rows
  // were cut off but whose manifest still claims the original count.
  it("rejects an archive whose row count no longer matches", () => {
    const a = archive();
    a.tables.people = [];
    const result = verifyManifest(a);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/people.*count/i);
  });

  it("rejects an archive whose contents were altered without the count changing", () => {
    const a = archive();
    a.tables.people = [{ id: "p_1", full_name: "Grace" }];
    const result = verifyManifest(a);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/people.*checksum/i);
  });

  it("rejects an archive that is missing a table the manifest promises", () => {
    const a = archive();
    delete a.tables.tags;
    expect(verifyManifest(a).ok).toBe(false);
  });

  // THE ONE THAT MATTERS. The manifest is built from the payload, so it can
  // only ever describe what is present. Drop a table from both and every
  // check above still passes: export succeeds, verification says ok, restore
  // reports success, and every follow-up is gone with nothing said.
  // The archive has to be self-describing at recovery time, on a machine that
  // may not have this repository, so the inventory check belongs in the file.
  it("rejects an archive missing a table the inventory requires", () => {
    const a = archive();
    delete a.manifest.tables.tags;
    delete a.tables.tags;
    const result = verifyManifest(a);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/tags.*inventory/i);
  });

  it("rejects an archive carrying a table the inventory does not know", () => {
    const a = archive();
    a.manifest.tables.mystery = { count: 0, checksum: checksum([]) };
    a.tables.mystery = [];
    expect(verifyManifest(a).ok).toBe(false);
  });

  it("rejects an archive written by a future format version", () => {
    const a = archive();
    a.manifest.format_version = 99;
    expect(verifyManifest(a).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project scripts scripts/lib/manifest.test.mjs`
Expected: FAIL, "Cannot find module ./manifest.mjs".

- [ ] **Step 3: Write the manifest module**

```javascript
// scripts/lib/manifest.mjs
import { createHash } from "node:crypto";
import { BACKED_UP, EXCLUDED } from "./inventory.mjs";


/**
 * Canonical JSON for one row: keys sorted, so a digest depends on content
 * and not on whatever order wrangler happened to serialize the columns in.
 * Row order is preserved, because row order is content.
 */
function canonical(row) {
  const keys = Object.keys(row).sort();
  return JSON.stringify(keys.map((k) => [k, row[k]]));
}

export function checksum(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(canonical(row)).update("\n");
  return hash.digest("hex");
}

export function buildManifest({ tables, schemaVersion, appVersion, exportedAt }) {
  const summary = {};
  for (const name of Object.keys(tables)) {
    summary[name] = { count: tables[name].length, checksum: checksum(tables[name]) };
  }
  return {
    format_version: 1,
    schema_version: schemaVersion,
    app_version: appVersion,
    exported_at: exportedAt,
    order: BACKED_UP.filter((t) => t in tables),
    tables: summary,
    // Copied into the file rather than referenced, because the person reading
    // this manifest during a recovery may not have the repository.
    excluded: { ...EXCLUDED },
    caveat:
      "Tables are read one at a time and writes are not blocked during the export, so two tables can describe moments a few seconds apart. Acceptable for a single-user database whose operator runs the export.",
  };
}

export const FORMAT_VERSION = 1;

export function verifyManifest(archive) {
  const problems = [];
  const { manifest, tables } = archive;

  if (manifest.format_version !== FORMAT_VERSION) {
    problems.push(
      `format_version is ${manifest.format_version}, this tool understands ${FORMAT_VERSION}`
    );
  }

  // Checked against the inventory, not against the manifest's own list. A
  // manifest derived from the payload cannot notice that the payload is short
  // a table, which is the failure that loses data in total silence.
  const present = new Set(Object.keys(manifest.tables));
  for (const name of BACKED_UP) {
    if (!present.has(name)) {
      problems.push(`${name}: required by the inventory, absent from this archive`);
    }
  }
  for (const name of present) {
    if (!BACKED_UP.includes(name)) {
      problems.push(`${name}: present in the archive but not in the inventory`);
    }
  }

  for (const [name, expected] of Object.entries(manifest.tables)) {
    const rows = tables[name];
    if (rows === undefined) {
      problems.push(`${name}: missing from the archive, manifest expects ${expected.count} rows`);
      continue;
    }
    if (rows.length !== expected.count) {
      problems.push(`${name}: count is ${rows.length}, manifest says ${expected.count}`);
      continue;
    }
    const actual = checksum(rows);
    if (actual !== expected.checksum) {
      problems.push(`${name}: checksum ${actual} does not match manifest ${expected.checksum}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project scripts scripts/lib/manifest.test.mjs`
Expected: PASS, 14 tests.

- [ ] **Step 5: Confirm the checksum test is not blind**

Change `canonical` to `JSON.stringify(row)` so key order is no longer normalized, and run again. Expected: FAIL on "stable across key order". Revert and confirm PASS. The mutation changes real behaviour, so this is a genuine guard.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/manifest.mjs scripts/lib/manifest.test.mjs
git commit -m "feat: add the archive manifest, with counts and checksums per table"
```

---

### Task 5: Reading a table through wrangler

The one module that touches the outside world. Everything above it stays testable because the command runner is injected.

**Files:**
- Create: `scripts/lib/d1.mjs`
- Create: `scripts/lib/d1.test.mjs`
- Modify: `docs/MEASUREMENTS.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parseExecuteJson(stdout: string): object[]` - pulls the row array out of whatever `wrangler d1 execute --json` prints.
  - `readRaw(sql: string, { database, remote, run }): Promise<object[]>` - runs SQL this codebase composed. Never caller input.
  - `readTable(name: string, { database, remote, run }): Promise<object[]>`
  - `runWrangler(args: string[]): Promise<string>` - the default runner, spawning the real binary.

- [ ] **Step 1: Record what `wrangler d1 execute --json` actually returns**

**Do not write the parser first.** The spec lists this output shape as an open question, and the last time this project assumed a wrangler capability without checking, the whole phase was invalid. Run it and read the answer.

```bash
npx wrangler d1 execute junco-prm --remote --json --command "SELECT id, full_name FROM people LIMIT 2"
```

Record the exact shape in `docs/MEASUREMENTS.md`: whether the top level is an array or an object, what the results live under, and what an empty result looks like. Then run it against a table you know is empty to see the empty shape:

```bash
npx wrangler d1 execute junco-prm --remote --json --command "SELECT * FROM confirmations LIMIT 1"
```

- [ ] **Step 2: Write the failing test, using the shape you just recorded**

The fixture below is the shape wrangler has historically produced. **If Step 1 showed something different, change the fixture to match what you saw, not the other way round.**

```javascript
// scripts/lib/d1.test.mjs
import { describe, expect, it, vi } from "vitest";
import { parseExecuteJson, readTable } from "./d1.mjs";

// Recorded from a real `wrangler d1 execute --json` run. See docs/MEASUREMENTS.md.
const WRANGLER_OUTPUT = JSON.stringify([
  {
    success: true,
    meta: { duration: 1.2, rows_read: 2, rows_written: 0 },
    results: [
      { id: "p_1", full_name: "Ada Lovelace" },
      { id: "p_2", full_name: "Grace Hopper" },
    ],
  },
]);

describe("parseExecuteJson", () => {
  it("returns the rows", () => {
    expect(parseExecuteJson(WRANGLER_OUTPUT)).toEqual([
      { id: "p_1", full_name: "Ada Lovelace" },
      { id: "p_2", full_name: "Grace Hopper" },
    ]);
  });

  it("returns an empty array for an empty result set", () => {
    const empty = JSON.stringify([{ success: true, meta: {}, results: [] }]);
    expect(parseExecuteJson(empty)).toEqual([]);
  });

  // wrangler prints progress lines before the JSON. Parsing the whole stdout
  // with JSON.parse throws on those, and the failure would look like a
  // corrupt database rather than a chatty CLI.
  it("ignores anything printed before the JSON", () => {
    const noisy = `Proxying to remote database\n Executed 1 command\n${WRANGLER_OUTPUT}`;
    expect(parseExecuteJson(noisy)).toHaveLength(2);
  });

  // The noise above contains no brackets, so it passes even against a naive
  // indexOf("["). This one does not. wrangler prints exactly this banner when
  // a newer version exists, and the day it does, backups stop.
  it("ignores a bracketed warning banner before the JSON", () => {
    const noisy = `[WARNING] Wrangler is out of date, please update\n${WRANGLER_OUTPUT}`;
    expect(parseExecuteJson(noisy)).toHaveLength(2);
  });

  // Silence must never read as an empty table. An empty array here would let
  // the export record "0 rows" for a table that simply failed to be read.
  it("throws rather than returning empty when there is no JSON at all", () => {
    expect(() => parseExecuteJson("Authentication error\n")).toThrow(/no JSON/i);
  });

  it("throws when wrangler reports the statement did not succeed", () => {
    const failed = JSON.stringify([{ success: false, error: "no such table: nope" }]);
    expect(() => parseExecuteJson(failed)).toThrow(/no such table/);
  });
});

describe("readTable", () => {
  it("selects everything from the named table against the remote database", async () => {
    const run = vi.fn().mockResolvedValue(WRANGLER_OUTPUT);
    const rows = await readTable("people", { database: "junco-prm", remote: true, run });
    expect(rows).toHaveLength(2);
    const args = run.mock.calls[0][0];
    expect(args).toContain("--remote");
    expect(args).toContain("--json");
    expect(args.join(" ")).toContain("SELECT * FROM people");
  });

  // A table name reaching a SQL string unchecked is an injection point, and
  // this one is interpolated because SQLite cannot bind an identifier.
  it("refuses a table name that is not a plain identifier", async () => {
    const run = vi.fn();
    await expect(
      readTable("people; DROP TABLE people", { database: "junco-prm", run })
    ).rejects.toThrow(/table name/i);
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project scripts scripts/lib/d1.test.mjs`
Expected: FAIL, "Cannot find module ./d1.mjs".

- [ ] **Step 4: Write the module**

```javascript
// scripts/lib/d1.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Only ever a bare table name. Interpolated into SQL, so nothing else passes. */
const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;

/**
 * wrangler prints human-readable progress to stdout before the JSON payload,
 * so the whole stream is not parseable. Find the first balanced JSON value
 * and parse that.
 */
export function parseExecuteJson(stdout) {
  // Match the payload's shape, not the first bracket. `indexOf("[")` finds the
  // one in a "[WARNING] Wrangler is out of date" banner and then fails to
  // parse the whole stream. `--json` sets wrangler's log level to error for
  // the run, so the stream should be clean, but a backup that stops working
  // the day wrangler prints a banner is not worth the two saved characters.
  const match = stdout.match(/\[\s*\{/);
  const start = match ? match.index : -1;
  if (start === -1) {
    throw new Error(`no JSON found in wrangler output: ${stdout.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (cause) {
    throw new Error(`could not parse wrangler JSON output: ${stdout.slice(0, 200)}`, { cause });
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first) throw new Error("wrangler returned no result objects");
  if (first.success === false) {
    throw new Error(`wrangler reported failure: ${first.error ?? "no error text"}`);
  }
  return first.results ?? [];
}

export async function runWrangler(args) {
  // 60 MB: a single table can be large and the default buffer truncates
  // silently, which would look like a short table rather than a failed read.
  const { stdout } = await execFileAsync("npx", ["wrangler", ...args], {
    maxBuffer: 60 * 1024 * 1024,
  });
  return stdout;
}

/** Runs SQL this codebase composed itself. Never pass caller input here. */
export async function readRaw(sql, { database, remote = true, run = runWrangler }) {
  const args = ["d1", "execute", database, "--json", "--command", sql];
  if (remote) args.splice(3, 0, "--remote");
  return parseExecuteJson(await run(args));
}

export async function readTable(name, { database, remote = true, run = runWrangler }) {
  if (!SAFE_TABLE.test(name)) {
    throw new Error(`refusing to read a table name that is not a plain identifier: ${name}`);
  }
  return readRaw(`SELECT * FROM ${name}`, { database, remote, run });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project scripts scripts/lib/d1.test.mjs`
Expected: PASS, 8 tests.

**Redact before recording.** `docs/MEASUREMENTS.md` is committed to a public repository, and a `SELECT` against `people` returns live contact rows. Record the JSON envelope and replace the row content with placeholders.

- [ ] **Step 6: Confirm the silence test is not blind**

Change `parseExecuteJson` so the `start === -1` branch returns `[]` instead of throwing. Run again. Expected: FAIL on "throws rather than returning empty". Revert and confirm PASS. This is the guard that stops a failed read being archived as an empty table, which is the quietest way this whole system could betray its user.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/d1.mjs scripts/lib/d1.test.mjs docs/MEASUREMENTS.md
git commit -m "feat: read a D1 table through wrangler, with the output shape recorded"
```

---

### Task 6: The export entry point

**Files:**
- Create: `scripts/export.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `BACKED_UP` (inventory), `buildManifest` (manifest), `readTable` (d1).
- Produces: `npm run export` writing `junco-backup-YYYY-MM-DD.json.bz2`, and `exportArchive({ database, run, now })` for tests.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/export.test.mjs
import { describe, expect, it, vi } from "vitest";
import { exportArchive } from "./export.mjs";
import { BACKED_UP } from "./lib/inventory.mjs";
import { verifyManifest } from "./lib/manifest.mjs";

const runner = () =>
  vi.fn(async (args) => {
    const sql = args[args.indexOf("--command") + 1];
    if (sql.includes("UNION ALL")) {
      const rows = BACKED_UP.map((t) => ({ t, n: t === "people" ? 1 : 0 }));
      return JSON.stringify([{ success: true, meta: {}, results: rows }]);
    }
    const table = sql.replace("SELECT * FROM ", "");
    const rows = table === "people" ? [{ id: "p_1", full_name: "Ada" }] : [];
    return JSON.stringify([{ success: true, meta: {}, results: rows }]);
  });

describe("exportArchive", () => {
  // Asserting the call count alone would pass if the same table were read
  // eleven times. Assert the actual set of tables.
  it("reads every table in the inventory, once each", async () => {
    const run = runner();
    await exportArchive({ database: "junco-prm", run, now: () => new Date("2026-08-27T12:00:00Z") });
    const selected = run.mock.calls
      .map((c) => c[0][c[0].indexOf("--command") + 1])
      .filter((sql) => sql.startsWith("SELECT * FROM "))
      .map((sql) => sql.replace("SELECT * FROM ", ""));
    expect([...selected].sort()).toEqual([...BACKED_UP].sort());
  });

  it("produces an archive that verifies against its own manifest", async () => {
    const archive = await exportArchive({
      database: "junco-prm",
      run: runner(),
      now: () => new Date("2026-08-27T12:00:00Z"),
    });
    expect(verifyManifest(archive)).toEqual({ ok: true, problems: [] });
  });

  // The failure this exists to catch: a query that silently returns fewer
  // rows than the table holds. Without the independent count, every check in
  // this plan endorses the short archive, because they all derive from it.
  it("aborts when a table read returns fewer rows than the database reports", async () => {
    const run = vi.fn(async (args) => {
      const sql = args[args.indexOf("--command") + 1];
      if (sql.includes("UNION ALL")) {
        // The count query: people really holds 2 rows.
        const rows = BACKED_UP.map((t) => ({ t, n: t === "people" ? 2 : 0 }));
        return JSON.stringify([{ success: true, meta: {}, results: rows }]);
      }
      const table = sql.replace("SELECT * FROM ", "");
      const rows = table === "people" ? [{ id: "p_1", full_name: "Ada" }] : [];
      return JSON.stringify([{ success: true, meta: {}, results: rows }]);
    });
    await expect(
      exportArchive({ database: "junco-prm", run, now: () => new Date() })
    ).rejects.toThrow(/people.*read 1.*reports 2/);
  });

  // The failure that matters: one table read fails, and the archive is
  // written anyway with that table empty. It must abort instead.
  it("aborts rather than writing an archive with a table that failed to read", async () => {
    const run = vi.fn(async (args) => {
      const sql = args[args.indexOf("--command") + 1];
      if (sql.includes("encounters")) return "Authentication error\n";
      return JSON.stringify([{ success: true, meta: {}, results: [] }]);
    });
    await expect(
      exportArchive({ database: "junco-prm", run, now: () => new Date() })
    ).rejects.toThrow(/encounters/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project scripts scripts/export.test.mjs`
Expected: FAIL, "Cannot find module ./export.mjs".

- [ ] **Step 3: Write the export script**

```javascript
// scripts/export.mjs
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readRaw, readTable, runWrangler } from "./lib/d1.mjs";
import { BACKED_UP } from "./lib/inventory.mjs";
import { buildManifest } from "./lib/manifest.mjs";

const execFileAsync = promisify(execFile);

export async function exportArchive({ database, run = runWrangler, now = () => new Date() }) {
  const tables = {};
  for (const name of BACKED_UP) {
    try {
      tables[name] = await readTable(name, { database, remote: true, run });
    } catch (cause) {
      // Abort. A partial archive that looks complete is worse than no archive,
      // because it is the one that gets trusted during a recovery.
      throw new Error(`failed to read ${name}, aborting the export`, { cause });
    }
    process.stdout.write(`  ${name}: ${tables[name].length} rows\n`);
  }

  // Ask the database how many rows there should have been, rather than
  // trusting the read that produced them. Without this the whole verification
  // chain is circular: the manifest counts what the export returned, and the
  // drill compares the restore against the manifest, so a query that silently
  // returned a short result is endorsed at every stage. A stray LIMIT would
  // pass every unit test in this plan.
  const counts = await countRows({ database, run });
  for (const name of BACKED_UP) {
    if (counts[name] !== tables[name].length) {
      throw new Error(
        `${name}: read ${tables[name].length} rows but the database reports ${counts[name]}. ` +
          `Aborting rather than writing a short archive.`
      );
    }
  }

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const migrations = BACKED_UP.length > 0 ? await latestMigration() : null;

  return {
    manifest: buildManifest({
      tables,
      schemaVersion: migrations,
      appVersion: pkg.version,
      exportedAt: now().toISOString(),
    }),
    tables,
  };
}

/**
 * One statement, one round trip, counting every backed-up table. Independent
 * of the queries that produced the archive, which is the entire point.
 */
export async function countRows({ database, run = runWrangler }) {
  const sql = BACKED_UP.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join(
    " UNION ALL "
  );
  const rows = await readRaw(sql, { database, run });
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

async function latestMigration() {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(new URL("../migrations", import.meta.url))).filter((f) =>
    f.endsWith(".sql")
  );
  return files.sort().at(-1) ?? null;
}

async function main() {
  const database = process.env.JUNCO_D1_DATABASE ?? "junco-prm";
  // Minute precision, not date. A date-only name plus `bzip2 -f` means the
  // second export of the day silently destroys the first, which is the one
  // that might have been taken before the thing that went wrong.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const jsonPath = `junco-backup-${stamp}.json`;
  const finalPath = `${jsonPath}.bz2`;

  process.stdout.write(`Exporting ${database}\n`);
  const archive = await exportArchive({ database });

  // Nothing is ever written under the final name until it has been compressed
  // AND integrity-checked. The earlier version renamed the JSON into place and
  // then compressed it there, so an interrupted bzip2 left a truncated file
  // under the name of a trusted backup.
  // Mode 0600 with flag "wx": this holds every contact and note in the
  // database, and an existing file must never be silently reused.
  const tmpJson = `${jsonPath}.partial`;
  await writeFile(tmpJson, JSON.stringify(archive, null, 2), { mode: 0o600, flag: "wx" });
  await execFileAsync("bzip2", ["-f", tmpJson]);
  await execFileAsync("bzip2", ["-t", `${tmpJson}.bz2`]);
  await chmod(`${tmpJson}.bz2`, 0o600);
  // Refuse to replace an existing archive. Minutes make a collision unlikely
  // rather than impossible, and the archive being overwritten may be the one
  // taken before whatever went wrong.
  if (existsSync(finalPath)) {
    throw new Error(`${finalPath} already exists. Refusing to overwrite an existing archive.`);
  }
  await rename(`${tmpJson}.bz2`, finalPath);

  const total = Object.values(archive.tables).reduce((n, rows) => n + rows.length, 0);
  process.stdout.write(`\nWrote ${finalPath}, ${total} rows, counts confirmed against the database, integrity verified.\n`);
  process.stdout.write(`Restore drill: npm run restore -- ${finalPath} <disposable-db>\n`);
}

// pathToFileURL rather than string concatenation. The naive form happens to
// work for this repository's path, and breaks for any path containing a space
// or a character that percent-encodes, by silently doing nothing at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`\nExport failed: ${error.message}\n`);
    if (error.cause) process.stderr.write(`Caused by: ${error.cause.message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project scripts scripts/export.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the npm script and ignore archives**

In `package.json`, add to `scripts`:

```json
"export": "node scripts/export.mjs"
```

Append to `.gitignore`:

```
# Backup archives. These hold every contact and note in the database.
junco-backup-*.json
junco-backup-*.json.bz2
junco-backup-*.json.partial
junco-backup-*.json.partial.bz2
```

- [ ] **Step 6: Run it against the live database**

```bash
npm run export
```

Expected: a row count per table, matching the live instance. `people` should exceed 42, `roster_entries` should read 798, `roster_sources` should read 1. A `junco-backup-YYYY-MM-DD.json.bz2` exists and `bzip2 -t` passed.

Confirm the file is not tracked:

```bash
git status --short
```

Expected: `junco-backup-*.json.bz2` does not appear.

- [ ] **Step 7: Commit**

```bash
git add scripts/export.mjs scripts/export.test.mjs package.json .gitignore
git commit -m "feat: export every durable table to a checksummed, compressed archive"
```

---

### Task 7: The restore

**Files:**
- Create: `scripts/restore.mjs`
- Create: `scripts/restore.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `BACKED_UP` (inventory), `verifyManifest` (manifest), `runWrangler` (d1).
- Produces: `npm run restore -- <archive> <database>`, and `insertStatements(tables)` returning SQL text in restore order.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/restore.test.mjs
import { describe, expect, it } from "vitest";
import { insertStatements, MAX_STATEMENT_BYTES } from "./restore.mjs";

describe("insertStatements", () => {
  it("emits an INSERT per row, in inventory order", () => {
    const sql = insertStatements({
      people: [{ id: "p_1", full_name: "Ada" }],
      tags: [{ id: "t_1", name: "speaker" }],
    });
    expect(sql.indexOf("INSERT INTO people")).toBeLessThan(sql.indexOf("INSERT INTO tags"));
  });

  // A single quote in a note is the most ordinary content imaginable, and an
  // unescaped one turns a restore into a syntax error at best.
  it("escapes single quotes in values", () => {
    const sql = insertStatements({ people: [{ id: "p_1", full_name: "O'Brien" }] });
    expect(sql).toContain("'O''Brien'");
  });

  it("writes NULL for null values rather than the string null", () => {
    const sql = insertStatements({ people: [{ id: "p_1", organization: null }] });
    expect(sql).toMatch(/VALUES\s*\('p_1',\s*NULL\)/);
  });

  it("writes numbers unquoted", () => {
    const sql = insertStatements({ people: [{ id: "p_1", rank: 3 }] });
    expect(sql).toMatch(/'p_1',\s*3/);
  });

  // FTS5 tables must never be written directly. Their content arrives via the
  // triggers when the source rows are inserted.
  it("never emits a statement against an FTS table", () => {
    const sql = insertStatements({ people: [{ id: "p_1" }] });
    expect(sql).not.toContain("people_fts");
    expect(sql).not.toContain("encounters_fts");
  });

  it("skips tables that are not in the inventory", () => {
    const sql = insertStatements({ people: [{ id: "p_1" }], idempotency_keys: [{ id: "x" }] });
    expect(sql).not.toContain("idempotency_keys");
  });

  // The failure this prevents is the nastiest one available: a row that
  // exports cleanly and cannot be restored, discovered during a recovery.
  // Whether D1's 100 KB statement limit reaches the import path is disputed,
  // so this refuses to find out the hard way.
  it("refuses to generate a statement over the size ceiling", () => {
    const huge = { id: "re_1", raw_record: "x".repeat(MAX_STATEMENT_BYTES + 1) };
    expect(() => insertStatements({ roster_entries: [huge] })).toThrow(/re_1.*ceiling|ceiling.*re_1/s);
  });

  it("allows a row comfortably under the ceiling", () => {
    const ok = { id: "re_2", raw_record: "x".repeat(1000) };
    expect(() => insertStatements({ roster_entries: [ok] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project scripts scripts/restore.test.mjs`
Expected: FAIL, "Cannot find module ./restore.mjs".

- [ ] **Step 3: Write the restore script**

```javascript
// scripts/restore.mjs
import { execFile } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readRaw } from "./lib/d1.mjs";
import { BACKED_UP } from "./lib/inventory.mjs";
import { verifyManifest } from "./lib/manifest.mjs";

const execFileAsync = promisify(execFile);

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  // SQLite has no boolean type and this schema stores none, so this branch
  // should never fire. It exists because if it ever does, the alternative is
  // quoting `true` into an INTEGER column, which SQLite casts to 0 in silence.
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Inventory order, not archive order, so foreign keys are satisfied even if
 * the archive was written by an older version that ordered tables differently.
 *
 * Nothing is emitted for the FTS5 tables. Inserting into `people` and
 * `encounters` fires the triggers from migrations 0004 and 0006, which is
 * what repopulates the indexes.
 */
/**
 * D1 documents a 100 KB maximum SQL statement. Whether that applies to the
 * bulk import path `--file` uses is genuinely disputed: one reviewer read
 * wrangler's source and concluded the file is handed to D1's import endpoint
 * rather than executed statement by statement, another pointed out that D1
 * still documents the per-statement limit and the import path still has to
 * parse the SQL.
 *
 * Rather than depend on being right, refuse to generate one. A statement that
 * would exceed the limit fails LOUDLY here, at export or drill time, instead
 * of during a recovery. 90 KB leaves headroom for encoding differences.
 */
export const MAX_STATEMENT_BYTES = 90_000;

export function insertStatements(tables) {
  const out = [];
  for (const name of BACKED_UP) {
    const rows = tables[name];
    if (!rows || rows.length === 0) continue;
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((c) => literal(row[c])).join(", ");
      const statement = `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${values});`;
      const bytes = Buffer.byteLength(statement, "utf8");
      if (bytes > MAX_STATEMENT_BYTES) {
        throw new Error(
          `${name} row ${row.id ?? "(no id)"} produces a ${bytes} byte statement, over the ` +
            `${MAX_STATEMENT_BYTES} byte ceiling. D1 documents a 100 KB statement limit. ` +
            `This row cannot be restored by this script and needs a different path.`
        );
      }
      out.push(statement);
    }
  }
  return out.join("\n");
}

async function main() {
  const [archivePath, database] = process.argv.slice(2);
  if (!archivePath || !database) {
    process.stderr.write("Usage: npm run restore -- <archive.json.bz2> <target-database>\n");
    process.exit(1);
  }

  const raw = archivePath.endsWith(".bz2")
    ? (await execFileAsync("bzcat", [archivePath], { maxBuffer: 512 * 1024 * 1024 })).stdout
    : await readFile(archivePath, "utf8");
  const archive = JSON.parse(raw);

  // Verify before writing anything. Restoring an archive that fails its own
  // manifest is how a corrupt backup becomes a corrupt database.
  const check = verifyManifest(archive);
  if (!check.ok) {
    process.stderr.write(`Archive failed verification:\n  ${check.problems.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Archive verified. Exported ${archive.manifest.exported_at}\n`);
  process.stdout.write(`Schema at export: ${archive.manifest.schema_version}\n`);

  // Refuse a non-empty target BEFORE touching it. An earlier version applied
  // migrations first, which meant a mistyped database name had Junco's schema
  // created in it before the script decided to refuse. Check, then mutate.
  //
  // A brand-new D1 has no tables at all, so the count query errors. That error
  // is the signal for "fresh and safe", and it is the only error tolerated
  // here.
  const countSql = BACKED_UP.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join(
    " UNION ALL "
  );
  let existing = [];
  try {
    existing = await readRaw(countSql, { database });
  } catch (error) {
    if (!/no such table/i.test(error.message)) throw error;
    process.stdout.write(`${database} has no Junco tables yet. Treating as empty.\n`);
  }
  const occupied = existing.filter((r) => Number(r.n) > 0);
  if (occupied.length > 0) {
    process.stderr.write(
      `Refusing to restore into ${database}: it already holds data.\n` +
        occupied.map((r) => `  ${r.t}: ${r.n} rows`).join("\n") +
        `\n\nRestore targets an empty database. There is deliberately no flag` +
        ` to override this: merging an archive into a populated database` +
        ` duplicates every row whose id does not collide, and reports success.` +
        ` If you mean to replace this database, empty it first, or use` +
        ` Time Travel instead.\n`
    );
    process.exit(1);
  }

  process.stdout.write(`Applying migrations to ${database}\n`);
  await execFileAsync("npx", [
    "wrangler", "d1", "migrations", "apply", database, "--remote",
  ]);

  // Written to the system temp directory, not the repository root. The old
  // path put every note and contact in the database into a plaintext file
  // beside the source, where nothing gitignored it.
  const sqlPath = join(tmpdir(), `junco-restore-${Date.now()}.sql`);
  await writeFile(sqlPath, insertStatements(archive.tables), { mode: 0o600, flag: "wx" });
  try {
    process.stdout.write(`Loading rows into ${database}\n`);
    // --yes matters. Remote --file warns that the database will be unavailable
    // and prompts when stdout is a TTY. Declining returns null and exits 0, so
    // without this the script prints "Restore complete" over a database that
    // received nothing at all.
    await execFileAsync(
      "npx",
      ["wrangler", "d1", "execute", database, "--remote", "--yes", "--file", sqlPath],
      { maxBuffer: 60 * 1024 * 1024 }
    );
  } finally {
    await unlink(sqlPath);
  }

  // Never claim success on the strength of an exit code. Count what landed.
  const after = await readRaw(
    BACKED_UP.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join(" UNION ALL "),
    { database }
  );
  const actual = Object.fromEntries(after.map((r) => [r.t, Number(r.n)]));
  const wrong = BACKED_UP.filter(
    (t) => actual[t] !== (archive.manifest.tables[t]?.count ?? 0)
  );
  if (wrong.length > 0) {
    process.stderr.write(
      `Restore did NOT complete. Row counts do not match the archive:\n` +
        wrong
          .map((t) => `  ${t}: ${actual[t]} in database, ${archive.manifest.tables[t]?.count} in archive`)
          .join("\n") + "\n"
    );
    process.exit(1);
  }

  process.stdout.write("\nRestore complete, row counts match the archive.\n");
  process.stdout.write("Now verify search with the FTS checks in docs/BACKUP.md.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`\nRestore failed: ${error.message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project scripts scripts/restore.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Confirm the escaping test is not blind**

Change `literal` so it does not call `replaceAll`, then run again. Expected: FAIL on "escapes single quotes". Revert and confirm PASS.

- [ ] **Step 6: Add the npm script**

In `package.json`, add to `scripts`:

```json
"restore": "node scripts/restore.mjs"
```

- [ ] **Step 7: Commit**

```bash
git add scripts/restore.mjs scripts/restore.test.mjs package.json
git commit -m "feat: restore an archive into a database, rebuilding FTS by reinsertion"
```

---

### Task 8: The restore drill

**An export nobody has restored is not a backup.** Everything before this task is a hypothesis. This task is the experiment.

**Files:**
- Modify: `docs/BACKUP.md`
- Modify: `docs/MEASUREMENTS.md`

**Interfaces:**
- Consumes: `npm run export` and `npm run restore`.
- Produces: a recorded, dated result proving the round trip works, or a recorded failure that becomes the next task.

- [ ] **Step 1: Create a disposable database AND put it in the config**

```bash
npx wrangler d1 create junco-restore-drill
```

Record the id it prints.

**The second half is not optional and the restore cannot run without it.**
`wrangler d1 execute` resolves a database by name against the API, but
`wrangler d1 migrations apply` does not: it reads `d1_databases` out of
`wrangler.jsonc` only, because it needs `migrations_dir` from that entry.
Pointing it at a database that is not in the config fails with
"Couldn't find a D1 DB with the name or binding ... in your wrangler.jsonc
file", every time.

Add a second entry to the `d1_databases` array in your live `wrangler.jsonc`,
using the id from above:

```jsonc
{
  // Temporary. Added for a restore drill, removed in Step 6.
  "binding": "RESTORE_DRILL",
  "database_name": "junco-restore-drill",
  "database_id": "PASTE_THE_ID_FROM_ABOVE",
  "migrations_dir": "migrations"
}
```

`wrangler.jsonc` is gitignored, so this change is local and is not committed.
Do not add the real id to `wrangler.example.jsonc`.

- [ ] **Step 2: Take a fresh export**

```bash
npm run export
```

Note the per-table row counts it prints. These are the numbers Step 4 compares against.

- [ ] **Step 3: Restore into the disposable database**

Use the filename the export actually printed in Step 2. It carries minutes,
not just a date, so `$(date +%F)` will not find it.

```bash
ls -t junco-backup-*.json.bz2 | head -1        # the newest archive
npm run restore -- "$(ls -t junco-backup-*.json.bz2 | head -1)" junco-restore-drill
```

Expected: verification passes, the target is confirmed empty, migrations
apply, rows load, and the final line reports that row counts match the
archive. Any other final line means the restore did not complete, regardless
of the exit code.

- [ ] **Step 4: Compare the restored database against the LIVE one**

The comparison must be against the source, not against the archive. Comparing
a restore to the manifest that was built from that same export is circular:
if the export read short, both sides agree and both are wrong.

Run the identical statement against both databases. All eleven tables, not a
subset; the earlier version of this step omitted `tags`, `roster_sources`, and
`import_runs` while claiming every count matched.

```bash
COUNTS="SELECT 'people' t, COUNT(*) n FROM people
 UNION ALL SELECT 'tags', COUNT(*) FROM tags
 UNION ALL SELECT 'person_contacts', COUNT(*) FROM person_contacts
 UNION ALL SELECT 'person_links', COUNT(*) FROM person_links
 UNION ALL SELECT 'person_tags', COUNT(*) FROM person_tags
 UNION ALL SELECT 'encounters', COUNT(*) FROM encounters
 UNION ALL SELECT 'followups', COUNT(*) FROM followups
 UNION ALL SELECT 'roster_sources', COUNT(*) FROM roster_sources
 UNION ALL SELECT 'import_runs', COUNT(*) FROM import_runs
 UNION ALL SELECT 'roster_entries', COUNT(*) FROM roster_entries
 UNION ALL SELECT 'person_sources', COUNT(*) FROM person_sources
 ORDER BY t"

npx wrangler d1 execute junco-prm --remote --json --command "$COUNTS" > /tmp/live-counts.json
npx wrangler d1 execute junco-restore-drill --remote --json --command "$COUNTS" > /tmp/drill-counts.json
diff <(python3 -c "import json,sys;print(json.load(open('/tmp/live-counts.json'))[0]['results'])") \
     <(python3 -c "import json,sys;print(json.load(open('/tmp/drill-counts.json'))[0]['results'])")
```

Expected: `diff` prints nothing. Any output is a discrepancy and the drill has
failed; record which table and stop rather than proceeding to Step 5.

Note the live counts may legitimately have moved if a write landed between the
export and now. If they differ, re-run the export and the drill back to back
rather than explaining the difference away.

**Counts are necessary and not sufficient.** The same number of rows carrying
different content passes the check above. So compare content too, by
re-exporting from the restored database and diffing the manifests. The export
already targets whichever database `JUNCO_D1_DATABASE` names, and the drill
database is in `wrangler.jsonc` from Step 1, so this needs no new code:

```bash
JUNCO_D1_DATABASE=junco-restore-drill npm run export

ORIGINAL="$(ls -t junco-backup-*.json.bz2 | sed -n 2p)"   # the one restored from
ROUNDTRIP="$(ls -t junco-backup-*.json.bz2 | head -1)"    # the one just taken

diff <(bzcat "$ORIGINAL"  | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['manifest']['tables'],indent=1,sort_keys=True))") \
     <(bzcat "$ROUNDTRIP" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['manifest']['tables'],indent=1,sort_keys=True))")
```

Expected: `diff` prints nothing. Every table's row count and SHA-256 matches,
which is content equality rather than cardinality equality.

If checksums differ while counts match, the likely cause is row ordering:
these queries carry no `ORDER BY`, and the checksum is order-sensitive by
design. Re-run both exports with a deterministic order before concluding the
data differs, and record what you found. Delete the round-trip archive
afterwards so it is not mistaken for a backup of the real database.

- [ ] **Step 5: Prove the FTS indexes rebuilt**

This is the step the whole design rests on, and the one most likely to fail. The indexes were never exported; they exist only if the triggers fired during the restore.

```bash
npx wrangler d1 execute junco-restore-drill --remote --json --command \
  "SELECT 'people_fts' t, COUNT(*) n FROM people_fts
   UNION ALL SELECT 'encounters_fts', COUNT(*) FROM encounters_fts"
```

Expected: `people_fts` equals the `people` count and `encounters_fts` equals
the `encounters` count, both from Step 4. Check both; an earlier version of
this step checked only `people_fts` and left the second index unverified.

Then prove search actually works rather than that a count is plausible:

```bash
npx wrangler d1 execute junco-restore-drill --remote --json --command \
  "SELECT p.full_name FROM people p WHERE p.id IN (SELECT f.id FROM people_fts f WHERE people_fts MATCH 'heaney')"
```

Expected: Rory Heaney.

**The column is `id`, not `record_id`.** `migrations/0004_search.sql` declares
`people_fts USING fts5(id UNINDEXED, full_name, ...)`, and `src/tools/search.ts`
queries it as `SELECT f.id AS id`. An earlier version of this step used
`record_id` and would have failed with "no such column", in the one step whose
failure this plan tells you to read as evidence that the triggers did not fire.

**If the FTS tables are empty**, the triggers did not fire on the bulk insert. Record that finding, and the fix belongs in `restore.mjs`: after loading rows, delete and reinsert into the FTS tables directly from the source tables. Do not paper over it in the runbook.

- [ ] **Step 6: Delete the disposable database and remove its config entry**

```bash
npx wrangler d1 delete junco-restore-drill
```

Then remove the `RESTORE_DRILL` block from `wrangler.jsonc`. A config entry
pointing at a database that no longer exists will fail the next deploy in a
way that looks unrelated to this drill.

Confirm the live config is back to one database:

```bash
grep -c "database_name" wrangler.jsonc
```

Expected: `1`.

- [ ] **Step 7: Record the drill in both documents**

In `docs/MEASUREMENTS.md`, record the date, the row counts, whether FTS rebuilt, and anything surprising.

In `docs/BACKUP.md`, append:

```markdown
## The archive

    npm run export

Reads every durable table by name through `wrangler d1 execute --remote`,
writes a checksummed JSON archive, compresses it with bzip2, and verifies
the compressed file.

**It names tables explicitly on purpose.** `wrangler d1 export` refuses
databases containing virtual tables, and this schema has two FTS5 indexes.
Naming the tables never touches them.

The archive excludes the FTS indexes, which are derived, and the three
operational tables. The manifest inside the file lists every exclusion and
its reason, so the file explains its own gaps to somebody who does not have
this repository.

### Cadence

Run it weekly, and before any migration. Time Travel covers 7 days on the
free plan, so a gap longer than a week is a period no layer covers.

Keep the files somewhere that is not the Cloudflare account. An archive
stored inside the account it exists to survive is not a backup.

### Restoring

    npm run restore -- junco-backup-YYYY-MM-DD.json.bz2 <target-database>

It verifies the archive against its own manifest before writing anything,
applies migrations, then loads rows in dependency order. FTS indexes are
repopulated by the triggers as rows are inserted.

### The drill

Re-run the round trip into a disposable database after any migration. An
export format that has not been restored since the schema changed is
untested again. The last drill and its result are recorded in
docs/MEASUREMENTS.md.

The drill needs its disposable database added to `wrangler.jsonc` first.
`wrangler d1 migrations apply` reads `d1_databases` from the config and does
not fall back to the API the way `d1 execute` does. Remove the entry when the
drill is finished.

### What the archive does not contain, and what account loss also needs

The archive holds D1 rows. Standing the instance back up after losing the
Cloudflare account needs more than that, and none of it is in the file:

- **The Worker itself.** Redeploy from this repository.
- **The KV namespace.** It holds OAuth grants. It is not backed up, and it
  does not need to be: re-adding the connector mints a new grant.
- **The three secrets.** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and
  `COOKIE_ENCRYPTION_KEY`, set with `wrangler secret put`. Keep them in a
  password manager, not here.
- **The GitHub OAuth App**, and its callback URL, which changes with the new
  Worker URL.
- **`wrangler.jsonc`**, which is gitignored and holds the resource ids. New
  resources mean new ids, so this is recreated from the template rather than
  restored.

The three operational tables are excluded by design, so after a restore an
in-flight retry may re-execute a write rather than replaying its recorded
result. That is the correct trade for a recovery and it is worth knowing.

### Where the files go

An archive stored inside the Cloudflare account it exists to survive is not a
backup. Keep them somewhere else, and write down where in this section once
that is decided, because a runbook that does not name the location is a
runbook that fails at the moment it is needed.
```

- [ ] **Step 8: Commit**

```bash
git add docs/BACKUP.md docs/MEASUREMENTS.md
git commit -m "docs: record the restore drill, and document the archive and its cadence"
```

---

## Self-Review

**Spec coverage.** Every requirement in spec P0 and P1 maps to a task: Time Travel verified and documented (Task 1), the runbook living in `docs/` rather than a personal checklist (Task 1), a script naming tables explicitly (Tasks 3 and 5), the manifest with counts and checksums (Task 4), dependency ordering (Task 3), atomic creation and restrictive permissions (Task 6), bzip2 with verification (Task 6), the table inventory enumerated explicitly including `raw_record_snapshot` and `raw_record`, which travel inside `person_sources` and `roster_entries` (Task 3), the restore performed rather than described (Tasks 7 and 8), and the cadence (Task 8). The spec's "corrected verification step" is honoured: Task 6 verifies with `bzip2 -t` and Task 8 with a row-count comparison, and no step looks for a `Dump completed` trailer.

**Two spec items deliberately deferred to a later plan**, recorded here so they are not mistaken for gaps. The bookmark-before-deploy step is documented in Task 1 but is only *exercised* in plans 2 and 3, which are the ones that deploy. And `docs/MEASUREMENTS.md` gains entries here but the per-phase live verification loop belongs to the plans that change the Worker.

**Placeholder scan.** No TBD, TODO, or "handle errors appropriately". Every code step carries runnable code. Task 5 Step 1 deliberately records a real output shape before the parser is written rather than assuming one, and Step 2 instructs the implementer to correct the fixture if reality differs. That is a known-unknown with a procedure, not a placeholder.

**Type consistency.** `BACKED_UP`, `EXCLUDED`, `ALL_KNOWN`, and `tablesInMigrations` are defined in Task 3 and used under those names in Tasks 4, 6, and 7. `checksum`, `buildManifest`, and `verifyManifest` are defined in Task 4 and used in Tasks 6 and 7. `parseExecuteJson`, `readTable`, and `runWrangler` are defined in Task 5 and used in Task 6. `exportArchive` and `insertStatements` are the two exported entry points and are named identically in their tests. `buildManifest` takes `{ tables, schemaVersion, appVersion, exportedAt }` in Task 4 and is called with exactly those keys in Task 6.

**One risk this plan carries deliberately.** Task 2 restructures `vitest.config.ts` underneath 475 passing tests. Step 6 of that task exists to catch a regression immediately, and it is the reason that task ships alone rather than folded into Task 3.
