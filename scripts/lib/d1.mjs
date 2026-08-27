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
