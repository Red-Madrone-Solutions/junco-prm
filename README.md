# Junco PRM

A personal relationship manager you talk to in plain language. It runs in your own Cloudflare account, and your data stays there.

Junco keeps track of the people you meet: who they are, where you met them, what you talked about, and what you said you would follow up on. It is built for quickly capturing details (in the moment or later, from your phone or your computer) and saving them for later recall and reconnection.

## Talk to it normally

Modern LLMs are great at interpreting what we say into action. Junco builds on this known interface to provide a durable backend to store, organize, and query details of relationships and encounters.

You describe what happened and the LLM works with Junco to record it.

> "I met Julia Golomb at WordCamp. She's an event manager and her Vistara event looks great. Remind me to signup for it."

> "Who do I know at Kinsta?"

> "What am I forgetting from last week's event?"

> "Remind me to email Bo in two weeks."

Behind those sentences are people, encounters, follow-ups, tags, contact details, and links, all queryable and all yours.

## Built for LLMs first

Junco's interface is a [Model Context Protocol](https://modelcontextprotocol.io) server, not a UI. It exposes a set of named tools that an AI assistant calls on your behalf, which means the assistant does the work of turning your sentence into the right operation.

**There are no built-in reports, and that is deliberate.** A conventional product ships the handful of views its author thought to build, and you are stuck with them. Junco ships your data and the tools to read it, and the assistant builds whatever you ask for at the time you ask. Request a table of everyone you have not spoken to since June. Ask for an HTML page covering who you met at a conference, grouped by company, and open it in a browser. Ask which follow-ups are overdue, then have it log three more while it is there. None of those had to be designed in advance, and none of them is a feature anybody has to maintain.

This is also why it is hosted rather than installed locally. A remote MCP server can be reached from a phone. A local one cannot, and the phone is where this is most useful.

Adding the connector is done once from the web or desktop app. After that it works everywhere you use Claude, including mobile.
## Own your own data

Junco is not a service anyone signs up for. You deploy it into your own Cloudflare account, and it stores everything in a D1 database that belongs to you.

- **Nobody else hosts it.** There is no shared server and no company in the middle. The people who wrote this code cannot read your records, because they never receive them.
- **One deployment serves one person.** There is no multi-tenancy, no user table, and no session store. Your instance holds your data and nothing else.
- **Sign-in is a doorbell, not a data source.** Junco uses GitHub only to confirm who is knocking. It requests no permissions, reads nothing from your GitHub account, and discards the token as soon as it has confirmed your identity. What it keeps is a single number.
- **You can take it with you.** Your records live in a standard SQLite database you can export at any time using Cloudflare's own tooling.

One thing worth being plain about: Junco is used through an AI assistant, so whatever you ask it to read is sent to that assistant to answer your question. If you use it with Claude, your records are processed under your own Anthropic account, subject to that account's terms. Junco keeps your data out of anyone else's hands, and it does not pretend that using it through an LLM is a closed loop.

## Load the list before you go

If you can get a list of who will be there, load it in advance. Junco calls this a roster and keeps it staged, separate from the people you actually know.

Then, when you meet someone, you write down only the part that is new:

> "Talked to Rory at the hallway track. He's rebuilding their design system and wants to compare notes in the fall."

Junco already has Rory's employer, his job title, and his email, because they came in with the list. You did not type any of it and you will not have to remember it later. Writing that note is what moves him out of staging and into the people you know. It is not a separate filing step, and there is nothing to tidy up afterward.

Everyone you never spoke to stays staged. Out of the way, still searchable, for the day six months from now when a name turns up in your inbox and you cannot place it.

If you want, when the event is over, you can delete the staged list. The people you wrote notes about stay stored, but the hundreds of attendees you never talked to and don't need data on? Junco tells you how many of those there are then it removes them all.

**Where do you get a list like that?** It varies more than you would want. Some communities publish full attendee lists, and WordPress is one of them, which is where this feature came from. More often the public part is the speaker list, the sponsors and exhibitors, or the session lineup, and any of those is worth loading on its own. Many conference apps have an attendee directory. Failing all of it, a list you type yourself of the twenty people you are hoping to find works exactly the same way. Junco does not care where the rows came from.


## Keeping real data out of this repository

This repository is public; the database it manages is not. `.githooks/pre-commit`
and `.githooks/pre-push` refuse any added line containing live personal data -
a contact's full name, an email address, an organization, a tag slug - matched
against the newest local `junco-backup-*.json.bz2`, which is gitignored. Nothing
sensitive is stored to run the check.

Enable them once per clone:

```bash
git config core.hooksPath .githooks
```

Only added lines are scanned, so existing content never trips the check. A term
that is genuinely legitimate here goes in `.githooks/allowlist.txt` with a reason.
A contact's name never does; remove the name from the file instead.

The commit hook warns and allows when no backup archive exists locally. The push
hook refuses, because a push is the point at which a mistake becomes public.

A git hook is only as good as the absence of `--no-verify`, so
`scripts/deny-verify-bypass.mjs` runs as a Claude Code `PreToolUse` hook and
refuses any shell command that would skip these hooks - including
`git commit -m "x" --no-verify`, where the flag trails the command and a
prefix-matching permission rule never sees it. It reads the whole command,
each half of a compound one included, and treats `git push -n` as the dry run
it is rather than a bypass. It is wired up in `.claude/settings.json`, which is
committed, so it arrives with a clone rather than having to be rebuilt on each
machine.

`docs/DEVELOPER.md` covers setup, the everyday commands, and what to do when the
check blocks you.

## How it is built

| Piece | What it uses |
|---|---|
| Runtime | Cloudflare Workers, TypeScript |
| Database | Cloudflare D1, with full-text search |
| Sessions and tokens | Cloudflare KV |
| Interface | MCP over Streamable HTTP, 32 tools |
| Sign-in | GitHub OAuth, no scopes requested |

## What it costs

Cloudflare's free plan is enough to run Junco, and for ordinary daily use it is not close to any limit. But the limit that actually binds is not the one people expect, so it is worth stating plainly.

**The constraint is Workers KV reads, not how much data you store.** Junco checks your authorization on every request, and each check reads from Cloudflare's key-value store. The free plan allows 100,000 of those reads per day. So the cost scales with how many requests you make, not with how many people you have recorded. Storage is a distant second concern: the free database holds 500 MB, and a personal relationship manager measured in thousands of people is single-digit megabytes.

For a sense of scale, from real use rather than estimation: importing an 800-person conference roster and building records from it consumed roughly two thirds of one day's read allowance. Looking someone up, logging that you met them, and checking what you owe people costs a tiny fraction of that.

So the shape of it is that everyday use is free and comfortable, and a large bulk import is the one thing that can run you into the daily ceiling. The counters reset at midnight UTC. If you cross the limit, Junco stops answering until the reset rather than degrading quietly, which is worth knowing before you start a big import late in the day.

If you would rather not think about it, the Workers Paid plan is 5 USD a month (as of August 2026) and raises the read allowance from 100,000 to 10 million per day.

## Status

Junco is deployed and in daily use by its author. The data layer and the Worker are complete, with 475 tests covering them.

**Installation instructions are still being written.** Deploying it today requires a Cloudflare account, a GitHub OAuth App, and comfort with `wrangler` at the command line. A step-by-step runbook, an upgrade guide, and a tested restore procedure are the next piece of work.

If you want to read ahead, the design documents in `docs/` describe the data model, the tool surface, and the reasoning behind the architecture in detail.

## License

MIT. See [LICENSE](LICENSE).
