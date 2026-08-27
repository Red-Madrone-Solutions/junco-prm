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
