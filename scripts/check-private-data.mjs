#!/usr/bin/env node
/**
 * Blocks live PRM personal data from entering a public repository.
 *
 * The term list is derived from the newest local `junco-backup-*.json.bz2`,
 * which is gitignored and therefore already trusted to hold real data. Nothing
 * sensitive is stored by this script or committed alongside it.
 *
 * Only ADDED lines are scanned. Content already in history never trips the
 * check, so the guard can be added to a repository that already has content
 * without a mass review first.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Columns worth treating as personal data, by table. */
const FIELDS = {
  people: ["full_name", "preferred_name", "organization", "job_title"],
  tags: ["name"],
  person_contacts: ["value", "normalized_value"],
  roster_entries: ["full_name", "preferred_name", "organization", "job_title", "email"],
};

/** Every non-empty string in the archive's personal-data columns. */
export function extractTerms(archive) {
  const terms = [];
  for (const [table, columns] of Object.entries(FIELDS)) {
    for (const row of archive.tables?.[table] ?? []) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value === "string" && value.trim() !== "") terms.push(value.trim());
      }
    }
  }
  return terms;
}

const isEmail = (term) => term.includes("@") && term.includes(".");

/**
 * Terms distinctive enough that finding one is evidence of a leak rather than
 * a coincidence. A single short word like "ruby" or "drupal" is a real tag AND
 * a word that belongs in this codebase, so matching it would only train
 * everyone to bypass the hook.
 */
export function distinctiveTerms(terms, allowlist = []) {
  const allowed = new Set(allowlist.map((entry) => entry.trim().toLowerCase()));
  const kept = new Set();
  for (const raw of terms) {
    const term = raw.trim().toLowerCase();
    if (term === "" || allowed.has(term)) continue;
    const multiWord = /[\s-]/.test(term) && term.length >= 6;
    if (isEmail(term) || multiWord || term.length >= 8) kept.add(term);
  }
  return [...kept];
}

/** Added lines from a unified diff, with the file and line each lands on. */
export function parseAddedLines(diff) {
  const added = [];
  let file = null;
  let lineNumber = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      added.push({ file, line: lineNumber, text: line.slice(1) });
      lineNumber += 1;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      lineNumber += 1;
    }
  }
  return added;
}

const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match on boundaries so "widgetworks" does not fire inside "widgetworksuite".
 * Hyphens count as word characters here, so a tag is not matched inside a
 * longer hyphenated slug either.
 */
export function findLeaks(addedLines, terms) {
  const patterns = terms.map((term) => ({
    term,
    regex: new RegExp(`(?<![\\w-])${escape(term)}(?![\\w-])`, "i"),
  }));
  const findings = [];
  for (const added of addedLines) {
    for (const { term, regex } of patterns) {
      if (regex.test(added.text)) findings.push({ file: added.file, line: added.line, term });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- CLI

const DAY = 24 * 60 * 60 * 1000;

export function newestBackup(dir = process.cwd()) {
  const names = readdirSync(dir)
    .filter((name) => /^junco-backup-.*\.json\.bz2$/.test(name))
    .sort();
  return names.length ? join(dir, names[names.length - 1]) : null;
}

function readAllowlist(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line !== "");
}

function main(argv) {
  const requireBackup = argv.includes("--require-backup");
  const rangeIndex = argv.indexOf("--range");
  const diff =
    rangeIndex === -1
      ? execFileSync("git", ["diff", "--cached", "-U0"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      : execFileSync("git", ["diff", "-U0", argv[rangeIndex + 1]], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (diff.trim() === "") return 0;

  const backup = newestBackup();
  if (!backup) {
    const message =
      "check-private-data: no junco-backup-*.json.bz2 found, so nothing can be checked.\n" +
      "  Run `npm run export` to create one.";
    if (requireBackup) {
      console.error(`${message}\n  Refusing to push without it.`);
      return 1;
    }
    console.warn(`${message}\n  Allowing this commit; push will refuse.`);
    return 0;
  }

  const raw = execFileSync("bzcat", [backup], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const archive = JSON.parse(raw);
  const exportedAt = Date.parse(archive.manifest?.exported_at ?? "");
  if (Number.isFinite(exportedAt) && Date.now() - exportedAt > 30 * DAY) {
    console.warn(
      `check-private-data: newest backup is ${Math.floor((Date.now() - exportedAt) / DAY)} days old; ` +
        "people added since then are not covered. Run `npm run export`.",
    );
  }

  const allowlist = readAllowlist(join(process.cwd(), ".githooks", "allowlist.txt"));
  const terms = distinctiveTerms(extractTerms(archive), allowlist);
  const findings = findLeaks(parseAddedLines(diff), terms);
  if (findings.length === 0) return 0;

  console.error("\ncheck-private-data: live personal data found in added lines.\n");
  for (const { file, line, term } of findings) {
    console.error(`  ${file}:${line}  contains  "${term}"`);
  }
  console.error(
    "\nThis repository is public. Remove the data, or if this is a false positive\n" +
      "add the term to .githooks/allowlist.txt with a comment saying why.\n",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
