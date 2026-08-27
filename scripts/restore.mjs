import { execFile } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { countRows } from "./export.mjs";
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
  // Reuse countRows from export.mjs rather than composing a UNION ALL here.
  // D1 rejects a compound SELECT past 5 terms with SQLITE_ERROR 7500, found by
  // executing Task 6 against the live database, and countRows already batches
  // around it. Writing the join again here would duplicate the bug.
  let existing = {};
  try {
    existing = await countRows({ database });
  } catch (error) {
    if (!/no such table/i.test(error.message)) throw error;
    process.stdout.write(`${database} has no Junco tables yet. Treating as empty.\n`);
  }
  const occupied = Object.entries(existing)
    .filter(([, n]) => Number(n) > 0)
    .map(([t, n]) => ({ t, n }));
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
  const actual = await countRows({ database });
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
