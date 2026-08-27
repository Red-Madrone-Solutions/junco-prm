import { execFile } from "node:child_process";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { countRows } from "./export.mjs";
import { readRaw, runWrangler } from "./lib/d1.mjs";
import { BACKED_UP } from "./lib/inventory.mjs";
import { verifyManifest } from "./lib/manifest.mjs";
import { insertStatements, MAX_STATEMENT_BYTES } from "./lib/sql.mjs";

export { insertStatements, MAX_STATEMENT_BYTES };

const execFileAsync = promisify(execFile);

/**
 * Whether `database` is safe to restore into: either it has none of Junco's
 * tables at all, or it has them all with no rows in any of them.
 *
 * Asks `sqlite_master` directly rather than inferring emptiness from a
 * `countRows` failure. A `countRows` batch can throw `no such table` when the
 * target is only partially migrated, for instance a drill database left over
 * from a previous failed attempt: some tables exist and hold rows, a later
 * batch hits a table that was never created, and the whole call rejects.
 * Reading that rejection as "no tables, therefore fresh" would load the
 * archive on top of the data the existing tables already hold. Zero tables in
 * `sqlite_master` is the only signal trusted here. Once that count is above
 * zero, every table is expected to exist and be countable, so a `countRows`
 * error at that point is a real error about the target and is left to
 * propagate, not swallowed.
 *
 * `name IN (...)` is a plain expression-list membership test, not a compound
 * `SELECT`, so the 5-term compound-SELECT ceiling documented on `countRows`
 * does not apply to it: confirmed locally against SQLite by running both an
 * 11-term `IN (...)` and an 11-term `UNION ALL` over the same eleven table
 * names, and both returned all eleven rows with no error. See the fix report
 * for the exact commands.
 */
export async function checkTargetEmpty({ database, run = runWrangler }) {
  const inList = BACKED_UP.map((t) => `'${t}'`).join(", ");
  const sql = `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${inList})`;
  const [row] = await readRaw(sql, { database, run });
  const tableCount = Number(row?.n ?? 0);
  if (tableCount === 0) {
    return { empty: true, occupied: [] };
  }

  const existing = await countRows({ database, run });
  const occupied = Object.entries(existing)
    .filter(([, n]) => Number(n) > 0)
    .map(([t, n]) => ({ t, n }));
  return { empty: occupied.length === 0, occupied };
}

/**
 * `verifyManifest` hard-fails on any table the current inventory requires and
 * the archive lacks, with no override by design. That is correct, but on its
 * own it reads as "reminders: required by the inventory, absent from this
 * archive" - true, and useless to an operator mid-recovery who has no way to
 * know a migration is the reason. This names the reason and the remedy.
 *
 * Returns null when the archive is not stale relative to disk, so it never
 * blocks a restore that would otherwise succeed.
 */
export function staleArchiveMessage({ archiveVersion, migrationsOnDisk }) {
  if (!migrationsOnDisk || migrationsOnDisk.length === 0) return null;
  const latest = [...migrationsOnDisk].sort().at(-1);
  if (!archiveVersion || archiveVersion >= latest) return null;
  return (
    `This archive was exported at schema ${archiveVersion}, older than the newest ` +
    `migration on disk (${latest}). The current table inventory expects tables added ` +
    `by migrations after this archive was taken, which is why verification fails below.\n` +
    `To restore it: check out the commit whose migrations/ directory matches ` +
    `${archiveVersion}, restore there, then apply the later migrations to bring the ` +
    `database up to date.`
  );
}

/**
 * The two safety-relevant steps of a restore, in the order that makes them
 * safe: refuse a non-empty target BEFORE running migrations against it, and
 * only load rows once migrations have applied cleanly.
 *
 * `applyMigrations` and `loadRows` are injected, the way `readTable` injects
 * `run`, so the ordering guarantee is observable in a test without shelling
 * out to wrangler.
 */
export async function loadIntoTarget({
  database,
  sql,
  manifestTables,
  checkTargetEmpty: checkEmpty = checkTargetEmpty,
  applyMigrations,
  loadRows,
  countRows: countRowsFn = countRows,
}) {
  const status = await checkEmpty({ database });
  if (!status.empty) {
    return { ok: false, reason: "occupied", status };
  }
  process.stdout.write(`${database} holds no Junco data. Proceeding.\n`);

  await applyMigrations({ database });
  await loadRows({ database, sql });

  // Never claim success on the strength of an exit code. Count what landed.
  const actual = await countRowsFn({ database });
  const wrong = BACKED_UP.filter((t) => actual[t] !== (manifestTables[t]?.count ?? 0));
  if (wrong.length > 0) {
    return { ok: false, reason: "count-mismatch", actual, wrong };
  }
  return { ok: true, actual };
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
    const migrationsDir = new URL("../migrations", import.meta.url);
    const migrationsOnDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql"));
    const staleness = staleArchiveMessage({
      archiveVersion: archive.manifest.schema_version,
      migrationsOnDisk,
    });
    if (staleness) process.stderr.write(`${staleness}\n\n`);
    process.stderr.write(`Archive failed verification:\n  ${check.problems.join("\n  ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Archive verified. Exported ${archive.manifest.exported_at}\n`);
  process.stdout.write(`Schema at export: ${archive.manifest.schema_version}\n`);

  // Generate the restore SQL before touching the target at all, migrations
  // included. An oversized row makes `insertStatements` throw, and if that
  // happens after `migrations apply` has already run, the target is left
  // migrated but empty rather than untouched. Computing it here means an
  // unrestorable archive fails before anything about the target changes.
  const sql = insertStatements(archive.tables);

  const result = await loadIntoTarget({
    database,
    sql,
    manifestTables: archive.manifest.tables,
    applyMigrations: async ({ database }) => {
      process.stdout.write(`Applying migrations to ${database}\n`);
      await execFileAsync("npx", [
        "wrangler", "d1", "migrations", "apply", database, "--remote",
      ]);
    },
    loadRows: async ({ database, sql }) => {
      // Written to the system temp directory, not the repository root. The
      // old path put every note and contact in the database into a plaintext
      // file beside the source, where nothing gitignored it.
      const sqlPath = join(tmpdir(), `junco-restore-${Date.now()}.sql`);
      await writeFile(sqlPath, sql, { mode: 0o600, flag: "wx" });
      try {
        process.stdout.write(`Loading rows into ${database}\n`);
        // --yes matters. Remote --file warns that the database will be
        // unavailable and prompts when stdout is a TTY. Declining returns
        // null and exits 0, so without this the script prints "Restore
        // complete" over a database that received nothing at all.
        await execFileAsync(
          "npx",
          ["wrangler", "d1", "execute", database, "--remote", "--yes", "--file", sqlPath],
          { maxBuffer: 60 * 1024 * 1024 }
        );
      } finally {
        await unlink(sqlPath);
      }
    },
  });

  if (!result.ok && result.reason === "occupied") {
    process.stderr.write(
      `Refusing to restore into ${database}: it already holds data.\n` +
        result.status.occupied.map((r) => `  ${r.t}: ${r.n} rows`).join("\n") +
        `\n\nRestore targets an empty database. There is deliberately no flag` +
        ` to override this: merging an archive into a populated database` +
        ` duplicates every row whose id does not collide, and reports success.` +
        ` If you mean to replace this database, delete it and create a fresh` +
        ` one under the same name; this is also the fix for a load that failed` +
        ` partway through a database created minutes earlier.\n`
    );
    process.exit(1);
  }

  if (!result.ok && result.reason === "count-mismatch") {
    process.stderr.write(
      `Restore did NOT complete. Row counts do not match the archive:\n` +
        result.wrong
          .map((t) => `  ${t}: ${result.actual[t]} in database, ${archive.manifest.tables[t]?.count} in archive`)
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
