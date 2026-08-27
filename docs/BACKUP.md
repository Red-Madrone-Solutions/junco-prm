# Backing up Junco PRM

Two layers, covering different failures. Reach for the right one.

| Failure | Layer | Cost to recover |
|---|---|---|
| A bad write or a bad migration in the last 7 days | Time Travel | One command, no artifact needed |
| Database deleted, account lost, or damage older than 7 days | The JSON archive | Whatever the last export captured |

## Time Travel

D1 keeps point-in-time history automatically. Retention is 7 days on the
free plan and 30 days on paid. The retention itself is automatic and needs
no setup, but recording a bookmark before a risky change is still a habit
worth keeping: it is not a prerequisite for Time Travel to work, but it is
what makes a restore fast instead of a search.

Check what is available:

    npx wrangler d1 time-travel info junco-prm

This prints a bookmark, for example:

    ⚠️ The current bookmark is '0000002d-00000000-000050d4-b7c899f681622bb0df214f940a12aa39'

Restore to that bookmark:

    npx wrangler d1 time-travel restore junco-prm --bookmark=<bookmark>

`time-travel restore` also accepts `--timestamp`, a Unix (seconds from
epoch) or RFC3339 timestamp, if you know the point in time you want but
did not capture a bookmark for it:

    npx wrangler d1 time-travel restore junco-prm --timestamp <timestamp>

Prefer `--bookmark` when one was captured, since it names an exact point
with no ambiguity. Use `--timestamp` only when no bookmark was recorded for
the moment you need.

**Restore is destructive and happens in place.** It replaces the current
database. There is no undo beyond restoring forward to a later bookmark,
and only within the retention window.

### Before every migration and every deploy

Record a bookmark first:

    npx wrangler d1 time-travel info junco-prm

Paste the bookmark into the deploy note for that change. If the deploy
goes wrong, that bookmark is the fastest way back and it costs one
command to capture.

### What Time Travel does not cover

Account loss, database deletion, and anything older than the retention
window. That is what the archive is for, and it is the reason the archive
exists at all.

## The archive

    npm run export

Reads every durable table by name through `wrangler d1 execute --remote`,
writes a checksummed JSON archive, compresses it with bzip2, and verifies
the compressed file.

**It names tables explicitly on purpose.** `wrangler d1 export` refuses
databases containing virtual tables, and this schema has two FTS5 indexes.
Naming the tables never touches them.

The archive excludes the FTS indexes, which are derived, and the three
operational tables. The manifest inside the file lists every exclusion and
its reason, so the file explains its own gaps to somebody who does not have
this repository.

### Cadence

Run it weekly, and before any migration. Time Travel covers 7 days on the
free plan, so a gap longer than a week is a period no layer covers.

Keep the files somewhere that is not the Cloudflare account. An archive
stored inside the account it exists to survive is not a backup.

### Restoring

    npm run restore -- junco-backup-YYYY-MM-DD.json.bz2 <target-database>

It verifies the archive against its own manifest before writing anything,
applies migrations, then loads rows in dependency order. FTS indexes are
repopulated by the triggers as rows are inserted.

### The drill

Re-run the round trip into a disposable database after any migration. An
export format that has not been restored since the schema changed is
untested again. The last drill and its result are recorded in
docs/MEASUREMENTS.md.

The drill needs its disposable database added to `wrangler.jsonc` first.
`wrangler d1 migrations apply` reads `d1_databases` from the config and does
not fall back to the API the way `d1 execute` does. Remove the entry when the
drill is finished.

### What the archive does not contain, and what account loss also needs

The archive holds D1 rows. Standing the instance back up after losing the
Cloudflare account needs more than that, and none of it is in the file:

- **The Worker itself.** Redeploy from this repository.
- **The KV namespace.** It holds OAuth grants. It is not backed up, and it
  does not need to be: re-adding the connector mints a new grant.
- **The three secrets.** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and
  `COOKIE_ENCRYPTION_KEY`, set with `wrangler secret put`. Keep them in a
  password manager, not here.
- **The GitHub OAuth App**, and its callback URL, which changes with the new
  Worker URL.
- **`wrangler.jsonc`**, which is gitignored and holds the resource ids. New
  resources mean new ids, so this is recreated from the template rather than
  restored.

The three operational tables are excluded by design, so after a restore an
in-flight retry may re-execute a write rather than replaying its recorded
result. That is the correct trade for a recovery and it is worth knowing.

### Where the files go

An archive stored inside the Cloudflare account it exists to survive is not a
backup. Keep them somewhere else, and write down where in this section once
that is decided, because a runbook that does not name the location is a
runbook that fails at the moment it is needed.
