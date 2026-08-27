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

// D1 rejects a compound SELECT past 5 terms with SQLITE_ERROR 7500, "too many
// terms in compound SELECT" (confirmed against the live database: 5 terms
// succeeds, 6 fails). One UNION ALL across all 11 backed-up tables cannot be
// a single round trip, so the count is batched instead.
const COUNT_BATCH_SIZE = 5;

/**
 * A handful of round trips, independent of the queries that produced the
 * archive, which is the entire point.
 */
export async function countRows({ database, run = runWrangler }) {
  const counts = {};
  for (let i = 0; i < BACKED_UP.length; i += COUNT_BATCH_SIZE) {
    const batch = BACKED_UP.slice(i, i + COUNT_BATCH_SIZE);
    const sql = batch.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join(
      " UNION ALL "
    );
    const rows = await readRaw(sql, { database, run });
    for (const r of rows) counts[r.t] = Number(r.n);
  }
  return counts;
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
