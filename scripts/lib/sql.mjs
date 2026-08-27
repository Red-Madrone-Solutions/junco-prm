import { BACKED_UP } from "./inventory.mjs";

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
 * D1 documents a 100 KB maximum SQL statement. Whether that applies to the
 * bulk import path `--file` uses is genuinely disputed: one reviewer read
 * wrangler's source and concluded the file is handed to D1's import endpoint
 * rather than executed statement by statement, another pointed out that D1
 * still documents the per-statement limit and the import path still has to
 * parse the SQL.
 *
 * Rather than depend on being right, refuse to generate one. A statement that
 * would exceed the limit fails LOUDLY at export time, instead of during a
 * recovery. 90 KB leaves headroom for encoding differences.
 */
export const MAX_STATEMENT_BYTES = 90_000;

/**
 * Inventory order, not archive order, so foreign keys are satisfied even if
 * the archive was written by an older version that ordered tables differently.
 *
 * Nothing is emitted for the FTS5 tables. Inserting into `people` and
 * `encounters` fires the triggers from migrations 0004 and 0006, which is
 * what repopulates the indexes.
 */
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
