# Junco CRM - Design

- Date: 2026-08-20
- Status: design approved, not yet implemented
- Author: Matt (Red Madrone Solutions), drafted with Claude

## Summary

Junco CRM is a small, single-user CRM whose primary interface is an MCP server rather than a web UI. It is deployed by each user to their own Cloudflare account as a Worker backed by D1, so the operator of the project hosts nothing and never sees anyone's data. Because remote MCP connectors work on Claude mobile, a deployed instance is usable from a phone, which is the requirement that drove the hosting decision.

## Goals

1. The agent is the interface. Adding a person, logging a conversation, and finding what is owed to whom all happen in natural language through MCP tools.
2. Usable on mobile, because the moment that matters most is standing in front of someone at a conference.
3. Shareable. A stranger can deploy their own blank instance and start using it.
4. The project owner stores no user data and operates no shared service.
5. Ingest of attendee and speaker rosters is a first-class feature, not an afterthought.

## Non-goals

- Multi-tenancy. One deployment serves exactly one person.
- A full web UI. A read-only export is in scope later; an editing UI is not.
- Sales pipeline features: deals, stages, forecasting, quotas.
- Email sync, calendar sync, or any third-party CRM integration.

## Constraints in tension, and how they resolve

Four constraints pulled against each other during design:

- The interface must be MCP.
- It must work on mobile.
- The project owner hosts nothing.
- The recipient's local stack is unknown.

MCP plus mobile forces a publicly reachable HTTPS server, because a phone cannot spawn a local process and, per Anthropic's connector documentation, the connection to a remote MCP server originates from Anthropic's servers rather than from the user's machine. That rules out stdio, localhost, LAN exposure, and tunnels for the mobile case.

The resolution is that the user hosts, not the project owner. Each user deploys their own Worker and D1 database into their own Cloudflare account. Data never leaves an account the user controls, and the project ships code and a deploy template rather than a service.

## Prior art in this repo's lineage

A throwaway prototype exists at `~/Projects/wcus-2026-ai-team-workshop`, built for WordCamp US 2026 and used live at the event. It holds 798 attendees imported from wordcamp.org, 32 of them marked speaker, with 13 contact statuses and 11 encounters recorded by hand during the conference.

Two things carry forward from it. The provenance columns (`source_url`, `source_captured_at`, `raw_record`) are what make an agent-driven import auditable and reversible, and they are kept. The ratio of 11 encounters against 798 roster rows is the observation the whole data model rests on: roughly 1.5 percent of an imported roster ever matters, and the rest is public data that can be re-fetched at any time.

Two things do not carry forward. `attendee_links` and `social_profiles` were two tables doing one job and are merged. The event-scoped framing, where a person exists only because they appeared on a roster, is replaced by the staged-versus-durable split below.

## Architecture

### Runtime

- TypeScript on Cloudflare Workers. Workers run JavaScript on V8, so this is determined rather than chosen.
- Cloudflare D1 for storage. D1 is SQLite underneath, so the schema and queries are ordinary SQLite.
- Local development runs against local D1 under Wrangler, which means no second storage backend is maintained for development.

### Layering

The nine tools are implemented as a pure module over a D1 handle, with a thin transport adapter on top. The HTTP adapter for Workers is the only one in v1. Keeping the tool layer transport-agnostic is nearly free now and expensive to retrofit, and it leaves an optional local stdio adapter available later without rework.

### Storage split

One D1 database per deployment, with tables divided by durability rather than by event:

- Staged tables hold imported roster data. Bulk, re-fetchable, and worthless within weeks. Written only by import.
- Durable tables hold people the user has actually engaged with, plus encounters and follow-ups. Small, irreplaceable, and the only thing that is backed up.

The user manages one artifact, not two, while the safety asymmetry is preserved in code: no tool other than import writes to staged tables, and roster data never flows back over durable data.

## Data model

Durable tables:

- `people` - names including preferred name, job title, organization as plain text, notes, `archived_at`, timestamps, plus `promoted_from_roster_entry_id` and `promoted_at` when the person came from an import.
- `person_links` - websites and social profiles in one table, typed by `link_type`.
- `tags` and `person_tags`.
- `encounters` - person, when, where, event, summary.
- `followups` - person, due date, note, `completed_at`.

Staged table:

- `roster_entries` - `source_key` naming the import, the person fields as imported, the prototype's `source_url`, `source_captured_at`, and `raw_record` unchanged, and a nullable `promoted_person_id`.

Search uses FTS5 over names, organization, job title, and note text, with bm25 ranking. D1's supported extension list includes the FTS5 module and `fts5vocab`, so no fallback strategy is required.

### Deliberate omissions

- No organizations table. A text column plus search answers "who else works at Kinsta" adequately at this scale. Add the table when org-level notes are actually needed.
- No groups or RSVP tracking, which the prototype used for a dinner invite list. Tags cover most of that need in v1.
- No delete. Archive only.
- No merge tool. See failure modes.

## MCP tool surface

The floor is three tools: find someone, read someone, write something down. That is a working LLM-first CRM. The shipped surface is nine:

1. `search_people` - hybrid search over names, organization, title, tags, and note text. Returns matches with organization and last encounter inline so the agent rarely needs a second call. Durable records by default; staged roster entries only when explicitly requested.
2. `get_person` - the entire record in one call: links, tags, every encounter, open follow-ups, provenance.
3. `upsert_person` - create or update. Updates require an explicit person id.
4. `log_encounter` - person, when, where, what happened, optional follow-up. The highest-frequency write.
5. `set_followup` - what is owed to someone and when.
6. `complete_followup` - close one out.
7. `list_due` - open follow-ups, overdue first. The tool that answers "what am I forgetting."
8. `import_roster` - CSV, JSON, or pasted text into staged rows with provenance stamped. Normalization is the agent's job rather than a parser's, which is where this beats a form-driven CRM.
9. `promote` - a staged roster entry becomes a person, surfacing duplicate candidates rather than resolving them.

Three design rules make this LLM-first rather than a REST API with a bow on it:

- Returns are rich, so one call usually suffices.
- Anything destructive proposes and waits for confirmation.
- Every write returns the full affected record, so mistakes are visible in the transcript immediately.

## Authentication

OAuth 2.1 is required, not optional. Anthropic's connector documentation reserves authless connectors for public data and test tools; anything holding private user data needs OAuth.

The starting point is Cloudflare's `workers-oauth-provider`, a complete OAuth 2.1 server implementation for Workers, via the published remote MCP server template. It can front any OAuth 2.0 identity provider, so sign-in with GitHub or Google is the expected path.

Because one deployment serves one person, authorization reduces to a single allowlisted account identifier held in an environment variable. No user table, no session store, no role model.

The Worker fails closed: if the owner allowlist variable is unset, it refuses to serve tools at all. The worst plausible outcome of a careless deploy is a stranger's contact list on the open internet, and that state must be unreachable by omission.

### Onboarding sequence

Claude on iOS and Android can use custom connectors but cannot add them. The documented order is therefore: deploy the Worker, add the connector once on claude.ai or Claude Desktop, and only then use it from the phone. A user who starts on mobile will hit a wall and blame the product, so this belongs prominently in the deploy instructions.

Free-plan Claude users are limited to one custom connector, which is worth noting when handing this to someone.

## Security and data handling

- TLS in transit, Cloudflare's encryption at rest, and account isolation.
- No application-layer encryption of note text. Encrypted text cannot be searched with FTS5, and the threat model is the user's own Cloudflare account rather than a shared host. This is a deliberate trade, not an oversight.
- No compression. A personal CRM is single-digit megabytes.

## Failure modes

- **A write against the wrong person** is the failure that will actually happen. Mitigated by disambiguating context in search results, by writes taking a person id rather than a name, and by every write echoing the full affected record.
- **Bad merges** are avoided by having no merge tool in v1. `promote` either links to an existing person or creates a new one, and duplicates are tolerated. A tolerated duplicate is cheap; an unreversible bad merge is not.
- **Import duplication** is prevented by idempotency on the pair of `source_key` and source row id, so a re-run updates rather than duplicates.
- **D1 batch limits** are handled by chunked writes during import, with progress reported back.
- **Schema migrations** run through Wrangler's D1 migrations, and user-deployed instances must apply them on deploy.
- **Data loss** is covered by `wrangler d1 export` plus an `export_crm` tool that returns the durable tables as JSON. That JSON export is also the diffable version history, which is a better answer than versioning a binary database file.

## Testing

- Tool functions are pure over a D1 handle and unit test against local D1 under Wrangler.
- Contract tests pin each tool's input and output shape.
- One end-to-end path: import a small roster fixture, promote a person, log an encounter, set a follow-up, list what is due.
- A fail-closed authorization test is non-negotiable.

## Phasing

- **Phase 1** - Worker plus D1, OAuth, the nine tools, migrations, deploy template, and deploy documentation covering the web-first connector setup.
- **Phase 2** - a read-only self-contained HTML export of durable data, which doubles as the shareable demo artifact and needs no hosting.
- **Later, only if wanted** - an optional local stdio adapter over the same tool module, and a merge tool designed against real duplicate data.

## Research findings, as of 2026-08-20

These were verified during design and should be re-checked if implementation starts much later.

- D1 supports the FTS5 module including `fts5vocab`: https://developers.cloudflare.com/d1/sql-api/sql-statements/
- Remote MCP connections originate from Anthropic's servers, not the user's machine; custom connectors are available on Free, Pro, Max, Team, and Enterprise, with Free limited to one: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Claude mobile can use remote MCP servers already added via claude.ai but cannot add new ones.
- Cloudflare `workers-oauth-provider` and the remote MCP server template: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/ and https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/

## Open questions

- Which identity provider the deploy template should default to for sign-in.
- Whether the WCUS prototype's 798 rows get imported into Matt's own instance as the first real test, or whether a smaller fixture is used first.
- What the connector display name should be as it appears in the Claude connector list, given the project name Junco CRM.
