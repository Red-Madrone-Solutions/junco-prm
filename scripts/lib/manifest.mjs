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
