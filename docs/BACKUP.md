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
