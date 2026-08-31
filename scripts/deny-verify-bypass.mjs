#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook. Refuses a Bash call that would skip the git
 * hooks guarding this repository's private data.
 *
 * The permission deny rules in .claude/settings.local.json only match command
 * PREFIXES, so `git commit -m "x" --no-verify` walks straight past them. This
 * inspects the whole command instead, including each half of a compound one.
 */

/** Command separators. A bypass hidden after `&&` is still a bypass. */
const SEPARATORS = /(?:&&|\|\||[;|\n])/;

/** `-n`, or `-n` bundled with other short flags such as `-nm`. */
const BUNDLED_N = /^-[a-zA-Z]*n[a-zA-Z]*$/;

function segmentBypasses(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const git = tokens.indexOf("git");
  if (git === -1) return false;
  // Only a leading `git` counts; `npm run build -- git` is not a git call.
  if (tokens.slice(0, git).some((token) => !token.includes("="))) return false;

  const rest = tokens.slice(git + 1);
  // Redirecting hooksPath disables the hooks without naming a flag they check.
  if (rest.some((token) => token.includes("core.hooksPath"))) return true;

  let subcommand = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "-c") {
      i += 1; // skip the config pair's value
      continue;
    }
    if (!rest[i].startsWith("-")) {
      subcommand = rest[i];
      break;
    }
  }
  if (subcommand !== "commit" && subcommand !== "push") return false;

  if (rest.includes("--no-verify")) return true;
  // `-n` means --no-verify for commit but --dry-run for push, which is harmless.
  return subcommand === "commit" && rest.some((token) => BUNDLED_N.test(token));
}

export function isVerifyBypass(command) {
  if (typeof command !== "string") return false;
  return command.split(SEPARATORS).some(segmentBypasses);
}

const REASON =
  "Blocked: this would skip the git hooks that keep live personal data out of " +
  "this public repository. Run the command without --no-verify. If the hook is " +
  "reporting a false positive, add the term to .githooks/allowlist.txt with a " +
  "reason instead of bypassing the check.";

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let command = "";
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? "";
  } catch {
    return; // Unparseable input is not a reason to block a build.
  }
  if (!isVerifyBypass(command)) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: REASON,
      },
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
