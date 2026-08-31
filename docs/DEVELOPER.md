# Working on Junco PRM

Setting up a checkout, running the tests, and the one piece of local
configuration that is not optional.

This document covers local development. Deploying a new instance from scratch -
creating the Cloudflare resources, registering the GitHub OAuth App, setting the
secrets - is not written yet; the README says so plainly and that runbook is
still outstanding work.

## First-time setup

Run these four in order.

### Install

```bash
npm install
```

### Enable the hooks

```bash
# NOT optional - see "The private-data guard" below
git config core.hooksPath .githooks
```

### Configure

```bash
# then fill in the two ids it asks for; the file is gitignored
cp wrangler.example.jsonc wrangler.jsonc
```

### Verify

```bash
npm test && npm run typecheck
```

## Why the hooks step is separate

Git deliberately refuses to let a cloned repository configure its own hooks
path. A repository that could would be a repository that runs code on your
machine the moment you clone it.

The consequence is that `.githooks/pre-commit` and `.githooks/pre-push` arrive
with the clone but stay inert until you run that `git config` line. Nothing
warns you. `git status` looks the same either way, the tests pass either way,
and the first sign that the guard was never on is data in a public commit.

If you skip only one step above, skip a different one.

## The private-data guard

This repository is public. The database it manages is not, and it holds real
people: names, email addresses, employers, and tags describing where you met
them and what they do.

`.githooks/pre-commit` and `.githooks/pre-push` refuse any **added** line
containing that data. The term list is built at run time from the newest local
`junco-backup-*.json.bz2`, which is gitignored, so nothing sensitive is stored
in order to run the check.

| Situation | pre-commit | pre-push |
|---|---|---|
| A term matches | Refuses | Refuses |
| No backup archive present | Warns, allows | Refuses |
| Archive older than 30 days | Warns | Warns |

A commit is local and reversible, so a missing archive should not stop you
working. A push is neither, so it fails closed.

Only added lines are scanned. Content already in history never trips the check,
which is what let the guard be added to a repository that already had content.

### When it blocks you

Two ways forward, and they are not equally good.

**Remove the data.** This is almost always right. A finding about the data is
usually what you wanted anyway: "one tag covers half the roster" carries the
insight without carrying the roster.

**Allowlist the term**, in `.githooks/allowlist.txt`, with a comment saying why.
This is for a value that really is in the database and really is legitimate
here - a generic job title like `engineer`, a company name that is also a test
fixture. **Never add a person's name.** If a contact's name is blocking a
commit, the name is the problem, not the check.

### The bypass block

A git hook is only as strong as the absence of `--no-verify`, and an agent
working in this repository can type that as easily as a person can.

`.claude/settings.json` carries deny rules for the obvious forms and a
`PreToolUse` hook (`scripts/deny-verify-bypass.mjs`) that reads the whole
command, because permission rules match command prefixes and
`git commit -m "x" --no-verify` hides the flag at the end where a prefix never
sees it. It also catches a bypass in the second half of a compound command and a
redirected `core.hooksPath`, and it leaves `git push -n` alone, that being a dry
run rather than a bypass.

This layer constrains Claude Code only. It does nothing about the same flag
typed into your own terminal - the git hooks are the layer that catches
everyone.

## Everyday commands

| Command | What it does |
|---|---|
| `npm test` | Full suite: the Worker tests under `tests/`, the script tests under `scripts/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run export` | Writes a `junco-backup-*.json.bz2` archive |
| `npm run restore` | Restores from one; see `docs/BACKUP.md` first |

Both test projects run from one `npm test`. The Worker suite runs in workerd
against real migrations; the script suite is plain Node, because those scripts
shell out to wrangler and touch the filesystem and workerd can do neither.

## Where things live

| Path | What is in it |
|---|---|
| `src/` | The Worker: auth, MCP transport, and one file per tool group |
| `migrations/` | Numbered SQL, applied in order, never edited once applied |
| `tests/` | Worker tests, `*.test.ts` |
| `scripts/` | Backup, restore, and the private-data check, `*.mjs` |
| `.githooks/` | The git hooks and their allowlist |
| `docs/` | This file, `BACKUP.md`, `MEASUREMENTS.md`, and the plans |
| `docs/MEASUREMENTS.md` | What was actually measured against a live instance, and when |

`docs/MEASUREMENTS.md` is worth knowing about before you assume something about
D1's behaviour. It records what was tested rather than what was expected,
including the times those differed.
