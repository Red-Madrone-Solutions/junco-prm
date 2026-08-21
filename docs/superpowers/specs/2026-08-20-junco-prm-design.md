# Junco PRM - Design

- Date: 2026-08-20
- Status: draft, under review. Nothing is implemented.
- Revised 2026-08-20, twice: first to record the three answers from Matt's review, then again after a four-agent independent review of the spec. The second pass reversed the two-provider decision, deleted the identity-echo mechanism, corrected several platform facts, and rewrote the data model, tool surface, and backup design. Decisions and their reversals are recorded in "Questions resolved on review" at the end.
- Revised a fourth time 2026-08-21, after a three-agent review of this spec (a fourth timed out). Three structural changes came out of it: **roster retirement was removed entirely** because no caller-supplied completeness claim can safely gate a destructive operation, **`person_roster_entries` was dropped** because a durable table pointing at disposable rows was the defect this spec claims to have fixed, and **nine tools were added to the surface**, which previously had no way to record an email address. Details in "Questions resolved on 2026-08-21" at the end.
- Revised again 2026-08-21, after a four-agent review of the phase 1 implementation plan sent four questions back up to the spec. The import protocol now sends each row once instead of re-transmitting the roster on every call, `people.notes` has a stated job, the backup is a local export rather than an undecided one, and the mobile-connector question was checked rather than deferred. See "Questions resolved on 2026-08-21" at the end. There are now no open questions.
- Author: Matt (Red Madrone Solutions), drafted with Claude

## Summary

Junco PRM is a small, single-user personal relationship manager whose primary interface is an MCP server rather than a web UI. It is deployed by each user to their own Cloudflare account as a Worker backed by D1 and a KV namespace, so the operator of the project hosts nothing and never receives anyone's data. Because remote MCP connectors work on Claude mobile, a deployed instance is usable from a phone, which is the requirement that drove the hosting decision. That claim is load-bearing, so it carries its caveat here as well as under Onboarding: connectors are usable on mobile, while installing one there is in beta and the supported path is web or desktop.

The database lives in the user's own Cloudflare account. Tool results, like those of any remote MCP server, are processed under the user's own Anthropic account. See Constraints for why that distinction matters and is stated rather than glossed.

## Goals

1. The agent is the interface. Adding a person, logging a conversation, and finding what is owed to whom all happen in natural language through MCP tools.
2. Usable on mobile, because the moment that matters most is standing in front of someone at a conference.
3. Shareable. A stranger can deploy their own blank instance and start using it, with an agent doing as much of that deploy as a machine can do.
4. The project owner stores nothing, receives nothing, and operates no shared service.
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

The resolution is that the user hosts, not the project owner. Each user deploys their own Worker and D1 database into their own Cloudflare account, and the project ships code and a deploy template rather than a service.

An earlier draft said "data never leaves an account the user controls." That is false and worth stating precisely, because the whole design rests on it. The project author hosts nothing and receives nothing. The database lives in the user's Cloudflare account. But every tool result travels from Cloudflare to Anthropic, by the same documented fact that forced this hosting decision in the first place: remote MCP connections originate from Anthropic's infrastructure. PRM contents are therefore processed under the user's own Anthropic account, and the deploy documentation discloses that rather than implying a closed loop.

## Prior art in this repo's lineage

A throwaway prototype exists at `~/Projects/wcus-2026-ai-team-workshop`, built for WordCamp US 2026 and used live at the event. It holds 798 attendees imported from wordcamp.org, 32 of them marked speaker, with 13 contact statuses and 11 encounters recorded by hand during the conference.

Two things carry forward from it. The provenance columns (`source_url`, `source_captured_at`, `raw_record`) are what make an agent-driven import auditable and reversible, and they are kept. The sparsity of user-authored data against imported data is the observation the whole model rests on: the great majority of an imported roster never matters, and the rest is public data that can be re-fetched at any time.

An earlier draft put that ratio at 11 against 798, or 1.5 percent, counting encounters alone. Re-querying the prototype on 2026-08-20 gives a truer figure: **36 of 798 attendees, 4.5 percent**, carry any user-authored data once contact statuses and group invitations are counted alongside encounters. The conclusion is unchanged and the number is three times larger, which matters for capacity planning rather than for the design.

The same query surfaced a fact the import design has to answer to: **11 names in that roster are duplicated, covering 23 rows**. A name is not an identity, so a name cannot be an import key.

Two things do not carry forward. `attendee_links` and `social_profiles` were two tables doing one job and are merged. The event-scoped framing, where a person exists only because they appeared on a roster, is replaced by the staged-versus-durable split below.

## Architecture

### Runtime

- TypeScript on Cloudflare Workers. Workers also support Python, Rust, and WebAssembly, so this is a choice rather than a platform requirement. It is chosen because the MCP and Cloudflare SDKs are TypeScript-first.
- Cloudflare D1 for storage. D1 is SQLite underneath, so the schema and queries are ordinary SQLite.
- A Workers KV namespace bound as `OAUTH_KV`. This is not optional and not a design preference: `workers-oauth-provider` requires it for authorization state and issued grants. A cookie encryption secret is required alongside it. Every deployment therefore provisions two storage resources, not one.
- Stateless Streamable HTTP transport, with no Durable Object. Cloudflare's `McpAgent` templates are deprecated for new servers, and stateless avoids both an extra binding and a class of session bugs.
- Local development runs against local D1 under Wrangler, which means no second storage backend is maintained for development.

### Layering

The tools are implemented as a pure module over a D1 handle, with a thin transport adapter on top. The HTTP adapter for Workers is the only one in v1. Keeping the tool layer transport-agnostic is nearly free now and expensive to retrofit, and it leaves an optional local stdio adapter available later without rework.

There is no identity-provider abstraction. An earlier draft specified a seam so that a second provider could be added behind it. With GitHub as the only provider, that seam would be an interface with one implementation, written against a second implementation that may never exist. The GitHub-specific code lives in one module so it is findable, and that is the whole of the arrangement. If a second provider is ever added, the interface gets extracted then, against two real cases rather than one real case and one imagined one.

### Storage split

One D1 database per deployment, with tables divided by durability rather than by event:

- Staged tables hold imported roster data. Bulk, re-fetchable, and worthless within weeks. Written only by import.
- Durable tables hold people the user has actually engaged with, plus encounters and follow-ups. Small, irreplaceable, and the only thing that is backed up.

The user manages one artifact, not two, while the safety asymmetry is preserved in code: no tool other than import writes to staged tables, and roster data never flows back over durable data.

## Data model

### Durable tables

- `people` - names including preferred name, job title, organization as plain text, notes, `archived_at`, timestamps. `notes` holds **standing facts that stay true between meetings**: a dietary restriction, who introduced you, what they care about. What happened on a particular day belongs in an encounter. The two fields are both free text about a person, which is how two fields drift into meaning the same thing, so the distinction is stated here and repeated in the tool descriptions an agent actually reads.
- `person_contacts` - email addresses and phone numbers, typed, with a verified-at where it applies. An earlier draft had nowhere to put an email address, which a roster import produces on the first row.
- `person_links` - websites and social profiles in one table, typed by `link_type`.
- `tags` and `person_tags`.
- `encounters` - person, when, where, event, summary, and `created_at`. There is no soft-delete column: `delete_encounter` is a hard delete by design, and a column no code writes is a column the next reader assumes is meaningful.
- `followups` - person, due date, note, `completed_at`, `cancelled_at`.
- `person_sources` - durable provenance, copied at promotion time rather than referenced: source key, external row key, `source_url`, `source_captured_at`, the roster's label and event as they read at promotion, and **both** a canonical-JSON snapshot of the raw record and its hash. An earlier draft said "a snapshot or hash" and left the choice open inside a document claiming no open questions. They do different jobs: the hash detects that the roster row changed since promotion, the snapshot is the only thing that can still show what was captured once the staged row is purged. A hash alone is worthless after the source disappears, which is exactly when provenance matters.

There is deliberately **no join table between a person and the roster rows they were promoted from.** An earlier draft had `person_roster_entries` and classified it durable while it pointed at staged rows, which is the same defect this section says was fixed, in a new shape: purging a roster either cascades into durable data or leaves rows in the backup pointing at data the backup does not contain. `person_sources` already stores `source_key` and `external_row_key`, and `roster_sources.source_key` is unique, so "has this roster row already been promoted?" is a join against durable provenance. That join survives a purge and a re-import a year later; a link to a staged row does not.

### Staged tables

- `roster_sources` - a logical roster that can be imported more than once: stable key, label, event, URL.
- `import_runs` - one attempt against a source: timestamp, format, status, the total the caller declared, how far it has got, and counts of inserted, updated, and skipped rows. There is no input hash: the server never sees the whole input under the chunked protocol below, so a hash of it cannot exist. Runs are bookkeeping and progress, not a lock.
- `roster_entries` - the imported row: its source, its `external_row_key`, the person fields as imported, the prototype's `source_url`, `source_captured_at`, and `raw_record` unchanged, plus the run that last saw it. There is no `retired_at`; see Import identity.

### Why provenance is three tables and not one column

An earlier draft used a single `source_key` on `roster_entries` and a pair of pointers, `people.promoted_from_roster_entry_id` and `roster_entries.promoted_person_id`. Three separate defects, all cheap now and expensive after real data exists:

- **`source_key` had to mean two things at once.** If it identifies a roster, a re-import overwrites the record of the earlier capture. If it identifies a particular run, idempotency across runs fails. It cannot do both, so it is split into `roster_sources` and `import_runs`.
- **The pointer pair cannot represent one person on two rosters,** which is the normal case for anyone attending a conference twice. It also stores the same relationship in two places, so the two drift. `person_sources` replaces it: one row per person per source row, so a person can carry as many origins as they have.
- **Durable data pointed at disposable data.** The staged tables are explicitly described as re-fetchable and are not backed up, yet a person's only provenance lived there. Promotion now copies provenance into `person_sources`, so purging a roster never strips a person of their origin.

### Import identity

Idempotency is on the pair `(roster_source, external_row_key)`, with a unique constraint enforcing it, so a re-run updates rather than duplicates.

`external_row_key` comes from the source when the source has one. When it does not, as with pasted text, it is the SHA-256 of the normalized row content. It is never the person's name: the prototype roster contains 11 duplicated names covering 23 rows, so a name is not an identity.

**Nothing is ever retired, and a re-import never removes anything.** An earlier draft tried to distinguish a row that vanished from the source from a row merely absent from a partial paste, and marked the vanished ones `retired_at` when a run claimed full coverage. That mechanism was removed on 2026-08-21 after three independent reviewers found the same hole in it: whether the run declared a row count or hashed its whole input, the completeness claim came from the same act of reading that could have truncated. An agent whose CSV was clipped, or whose page lazy-loaded 300 of 798 rows, declares the total it can see, satisfies every check, and retires 498 current rows with nothing said out loud. A caller assertion cannot gate a destructive operation.

A stale roster is replaced rather than reconciled: `purge_roster_source` and then import again. That is cheap precisely because this spec already describes staged data as bulk, re-fetchable, and worthless within weeks, and because purge is a two-call confirmed operation while retirement was a boolean argument. Promoted people keep their provenance either way, since `person_sources` is durable and copied at promotion.

Removing retirement also removes everything that existed to protect it. There is no need to enforce one open run per source, no deadlock when an agent abandons a run mid-way, no `abandon_import` tool, and no consequence to two runs interleaving against one source beyond untidy counters, because no code path turns "this run did not see that row" into an action.

### Search

Search uses FTS5 with bm25 ranking. Two indexes, not one, because people and encounters are different entities and conflating them produces results an agent cannot explain: one over `people` (names, organization, job title, notes) and one over `encounters` (summary). Tags participate in people search too, matched directly against the tag tables rather than through the index, because tag membership changes without `people` being written and no trigger on `people` would fire.

Both indexes are **standalone FTS5 tables carrying the record's text id as an `UNINDEXED` column**, kept in sync by SQLite triggers declared in the migrations, so application code cannot forget to update them. They are deliberately not external-content tables. `people.id` and `encounters.id` are `TEXT PRIMARY KEY`, so those tables have no explicit `INTEGER PRIMARY KEY` and their rowids are the implicit ones SQLite assigns, which `VACUUM` is documented to renumber. An external-content index keyed on that rowid can therefore be silently detached from its content, and the symptom is search returning the wrong people rather than an error. Carrying the text id costs a second copy of the searchable text, which is a few megabytes against a 500 MB database.

An earlier draft called this "hybrid search" without defining it. There is no embedding store and no vector search. The term is dropped: it is FTS5, with a prefix-match fallback for short queries where FTS5 tokenization is unhelpful.

### Deliberate omissions

- No organizations table. A text column plus search answers "who else works at Kinsta" adequately at this scale. Add the table when org-level notes are actually needed.
- No groups or RSVP tracking, which the prototype used for a dinner invite list. Tags cover most of that need in v1.
- No merge tool. See failure modes.
- No delete for people. Archive only, with one exception below.

### Where delete is required

"No delete" is right for people the user has chosen to record and wrong everywhere else, and an earlier draft applied it universally.

- **Staged roster data must be purgeable.** The spec calls it worthless within weeks; a design with no way to remove it contradicts itself and lets a database fill with third-party contact data the user never engaged with.
- **Encounters must be correctable and removable.** `log_encounter` is the highest-frequency write and is often dictated on a phone. A wrong one that cannot be fixed is a permanent error in the record.
- **A hard delete path for a person must exist,** even though it is not the default and is not exposed casually. A PRM holding other people's contact details cannot answer a deletion request with "we only archive."

## MCP tool surface

The floor is three tools: find someone, read someone, write something down. That is a working LLM-first PRM.

An earlier draft fixed the shipped surface at nine and treated that count as a design constraint. It is not one. The marginal cost of one more well-named tool is close to zero, and the cost of one overloaded tool an agent misuses is a wrong write against a real person. The surface is sized by how unambiguous each choice is for an agent, not by a target number.

### Reads

1. `search_people` - FTS5 search over names, organization, title, tags, and note text. Takes an explicit `scope` of `contacts`, `roster`, or `all`, never a boolean flag. It returns **two named arrays, `people` and `roster_entries`,** rather than one list with a `record_kind` discriminator. This spec names "a write against the wrong person" as the failure most likely to actually happen, and an agent cannot confuse two kinds of record that never share an array. Each hit carries organization and last encounter inline so a second call is rarely needed, and roster hits never carry `raw_record`.
2. `get_person` - the record in one call: contacts, links, tags, open follow-ups, provenance, and recent encounters with a total count. Encounter history paginates rather than promising every encounter forever.
3. `list_encounters` - by person, event, or date range. Answers "who did I meet at WordCamp," which is a top-three conference question that `search_people` cannot answer.
4. `list_due` - open follow-ups, overdue first. The tool that answers "what am I forgetting."
5. `list_roster_sources` - what has been imported, when, how much of it has been promoted, and how old it is. Age is there so an agent can suggest purging a roster nobody has touched in months, which nothing else in the surface would ever raise.
6. `export_data` - durable records a page at a time, with an explicit scope and cursor. It answers "give me my data" inside a conversation. It is **not** the backup, for the reason under Backup and restore: a tool result is capped at roughly 150,000 characters, so an export worth having is an export that truncates.

### Writes

7. `create_person` - creates. Fails if it would need an id. It runs the same duplicate check `promote` does, against people **and** staged roster entries, and refuses on a strong match unless given `force: true`, returning the candidates instead. Without that check the most common sentence a user says at a conference, "add Jane, I just met her," silently creates a durable duplicate of a roster row that was sitting there waiting to be promoted, and loses her provenance permanently.
8. `update_person` - updates scalar fields by explicit person id. It does not touch contacts, links, or tags; those have their own tools below.
9. `archive_person` and `unarchive_person` - set and clear `archived_at`, which previously existed as a column no tool could set.
10. `delete_person` - permanent, two calls, preview then confirm. It exists because a PRM holding other people's contact details cannot answer a deletion request with "we only archive." An earlier draft argued for it in prose and then left it out of this list.
11. `add_contact` and `remove_contact` - an email address or phone number.
12. `add_link` and `remove_link` - a website or social profile.
13. `set_tags` - replaces the whole tag set for a person.
14. `log_encounter` - person, when, where, what happened, optional follow-up. The highest-frequency write.
15. `update_encounter` and `delete_encounter` - correct or remove a mis-logged encounter. Delete here is a hard delete in one call, deliberately outside the two-call rule below, because the point is to erase a mistake someone just dictated from a phone.
16. `set_followup`, `complete_followup`, `cancel_followup` - what is owed to someone, closing it out, and dropping it.
17. `import_roster` - one chunk of a roster. See below.
18. `finalize_import` - closes a run. It retires nothing and destroys nothing; see Import identity.
19. `promote` - two calls, not one. See below.
20. `purge_roster_source` - removes a staged source and its entries, two calls, preview then confirm. Promoted people and their copied provenance are untouched.

That is 26 named tools, since five of the numbered items above are two or three tools each. The count is stated because an earlier draft numbered its list to 14, was actually 19, and omitted tools its own prose required. A spec that argues about surface size should be able to count its own surface.

Attributes get their own tools rather than arrays on `update_person`. The alternative was considered and rejected: with replace-arrays, omitting a field has to mean "leave alone" while passing an empty array means "delete every contact this person has," and that is a destructive distinction an agent gets wrong silently. Separate tools remove the ambiguity instead of documenting it.

`create_person` and `update_person` replace a single `upsert_person`. Requiring an explicit id for updates was right and is kept; the name was the problem. "Upsert" invites an agent to assume the server will match on name, and this server never matches on name to select a record. Name similarity appears in exactly one place, as **evidence returned to the caller** by `promote` and `create_person`, and it never picks a person on its own.

### Id discipline

Every id is prefixed by kind and every tool validates the prefix: `p_` for a person, `re_` for a roster entry, `enc_` for an encounter, `fu_` for a follow-up, `rs_` for a roster source.

This is not cosmetic. `search_people` can return two entity kinds, and the failure the spec names as most likely, a write against the wrong person, arrives most easily by an agent passing a roster entry id into `log_encounter`. A prefixed id makes that a validation error instead of a corrupted record.

### `promote` is two-phase

Surfacing duplicate candidates and committing a promotion cannot happen in one call, because the agent has to see the candidates before choosing.

- `promote(roster_entry_id)` writes nothing and returns duplicate candidates with the evidence for each. Evidence includes a shared email, a shared name, a shared organization, and, strongest of all, an existing `person_sources` row carrying this roster's `source_key` and this row's `external_row_key`, which means this exact row was promoted before, possibly under an earlier import of the same roster.
- `promote(roster_entry_id, link_to_person_id | create_new: true)` commits, and copies provenance into `person_sources`.
- Promotion is idempotent. Calling it on a row that has already been promoted returns the existing person rather than creating a second one. Tolerating duplicates the system cannot detect is a considered position; creating one the system is already holding provenance for is a bug.

### `import_roster` is resumable across calls

An earlier draft passed a whole CSV through one tool call and described "chunked writes with progress reported back." That does not work, for two separate reasons.

The first is a platform limit. D1 allows 100 bound parameters per query and, on the free plan, 50 queries per Worker invocation. `roster_entries` has roughly a dozen columns, so a multi-row insert carries about 8 rows, and 798 rows is roughly 100 statements. Chunking inside one invocation does not help, because the cap is per invocation. Free Workers also allow 10 ms of CPU per invocation, which parsing a large CSV can exceed on its own.

The second is that an MCP tool call is one-shot. There is no channel for a server to report progress during a call, so "progress reported back" was not implementable as written.

Import is therefore a protocol, and the tool contract says so:

- `import_roster(source_key, label, source_url, format, rows, expected_total?, run_id?, offset?)` returns `{run_id, imported, updated, skipped, errors, next_offset, remaining}`. The agent loops until `remaining` is zero, then calls `finalize_import(run_id)`.
- **The first call declares `expected_total`** and carries the first chunk. The server opens a run recording that total, and every later call carries `run_id`, the `offset` it is continuing from, and only its own chunk. `expected_total` drives progress reporting and nothing else; it gates no destructive action, because there is no longer a destructive action for it to gate.
- **`offset` must equal the run's `next_offset` exactly.** A call that skips ahead or replays committed ground is refused, so the agent's loop stays honest and `remaining` means what it says. A mismatch is a recoverable error: the response carries the run's true `next_offset` and `remaining`, so the agent's next call is obviously correct rather than a guess.
- **A chunk is idempotent on `(run_id, offset)`.** A retry after a dropped response replays the original result instead of being rejected, which is what makes the single most likely runtime failure in the system self-healing. An explicit `idempotency_key` is accepted but not required for this.
- Each call is capped at a server constant well under the free-plan limits, on the order of 150 rows. A chunk larger than the cap is **rejected, not truncated**: the agent decides the chunking, so silently dropping the tail would lose rows without anything saying so.
- Parsing CSV and JSON is deterministic server code, and the agent sends each row exactly once across the whole run. An earlier version of this contract took the entire `rows` array on every call and sliced it server-side, which meant a 798-row roster crossed the model six times. That was decided against on 2026-08-21.
- Validation happens in application code before any query, so per-row errors are reported without costing a query each. Writes are batched multi-row upserts, which report aggregate inserted and updated counts. A row the server refuses consumes its offset and is reported with its index and reason; the agent fixes those rows and sends them as an ordinary later import rather than as a continuation.
- Committed chunks are live immediately. A half-imported roster is a usable roster: its rows are searchable under `scope: roster` and promotable. That is deliberate, because the moment this feature exists for is standing at a conference with a partially-loaded attendee list.

**Where the chunk cap comes from.** It is derived from the query budget rather than chosen: the free plan allows 50 D1 queries per Worker invocation and 100 bound parameters per statement, `roster_entries` has about 15 bound columns, so a multi-row upsert carries six rows, and 150 rows is 25 upsert statements plus a handful of bookkeeping queries. **This arithmetic assumes each statement inside a `db.batch()` counts individually against the 50-query cap.** Cloudflare's limits page states that per-statement limits apply inside a batch and says nothing about subrequest counting, and reviewers disagreed about it. The strict reading is assumed because it fails safe: if a batch is really one subrequest, the cap is merely lower than it needed to be. It is measured against a real Worker in the first implementation task before any import code is written, and the number here changes if the measurement says so.

**What the server can and cannot verify about a resumed run.** It checks that the run exists and is open, that it belongs to the source and format being imported, and that the offset is the one expected. It cannot verify that the chunk in front of it comes from the same roster the run was opened against, because it no longer sees the whole input. **Nothing rests on that verification any more.** Under the previous design the declared count gated retirement, and three reviewers independently showed that a caller-supplied count cannot gate a destructive operation; retirement is gone and the question went with it. The worst a wrong `expected_total` can now do is make `remaining` misleading.

### Rules that make this LLM-first

- Returns are rich, so one call usually suffices.
- Every write returns the full affected record, so mistakes are visible in the transcript immediately.
- Every write takes an optional `idempotency_key`. Mobile connections drop, clients retry, and a retried `log_encounter` must not produce a second encounter.
- Destructive operations against a person or a whole roster use an explicit two-call protocol: the first call returns a preview and a confirmation token, the second call presents that token. `delete_person` and `purge_roster_source` are the two. `delete_encounter` is a deliberate exception and deletes in one call, because it exists to erase a mistake someone just made. An earlier draft said destructive things "propose and wait for confirmation," which a one-shot tool call cannot do. The client's own approval UI is a second layer, not a substitute.
- **Every read tool has a default and a maximum page size, and one pagination convention:** an opaque cursor plus `limit`, the same everywhere. Anthropic caps a tool result at roughly 150,000 characters, and `search_people` over a 798-row roster or an unbounded `list_encounters` reaches that as easily as an export does.
- **Every tool result carries the current date in the owner's time zone.** The agent does not otherwise know it, and "follow up tomorrow" dictated at 11pm Pacific is wrong for a third of every day if the model assumes UTC or guesses. This is one field on every response and it removes an entire class of off-by-one errors from the highest-frequency writes.
- **Errors are part of the tool surface, not plumbing.** Every rejection returns a machine-readable code, a human-readable reason, and, where one exists, the corrective next call. An `re_` id passed to `log_encounter` says "promote this roster entry first" rather than only "invalid id," because the caller is a model that will otherwise guess.

## Authentication

OAuth 2.1 is required, not optional. Anthropic's connector documentation reserves authless connectors for public data and test tools; anything holding private user data needs OAuth.

### Two OAuth roles, not one

The Worker plays both sides of OAuth, and conflating them is the easiest way to design this wrong.

- **The Worker is an OAuth server to Claude.** Claude registers itself through Dynamic Client Registration, and the flow uses PKCE and metadata discovery against the callback `https://claude.ai/api/mcp/auth_callback`. Cloudflare's `workers-oauth-provider` implements this side in full, so it is a configuration job rather than a build job.
- **The Worker is an OAuth client to GitHub.** This is the side the project actually writes: the authorization redirect, the callback and state validation, the token exchange, and the call that resolves the signed-in identity.

`workers-oauth-provider` supplies protocol machinery, not an application. Consent, CSRF protection, state validation, cookie handling, and every application-level access check remain the project's responsibility. The library validates its own issued bearer token and explicitly leaves authorization to the handler.

### One provider: GitHub

GitHub is the only identity provider. An earlier draft shipped GitHub and Google both, selected at deploy time; that was reversed on 2026-08-20 after review, and the reasoning is worth keeping.

Google is by a wide margin the more expensive of the two. It needs a Cloud project, consent-screen configuration, a test-user or publishing decision, and it shows an unverified-app warning to the very stranger the project is trying not to lose. It also brings ID-token validation, issuer and audience checks, and refresh-token handling that GitHub's opaque non-expiring tokens do not. Against that, the audience for a Worker deployed from a terminal already has a GitHub account.

Supporting both would have doubled the deployment and end-to-end test matrix before either path was proven once. GitHub is not a default with a fallback behind it. It is the provider.

### Owner authorization

Because one deployment serves one person, authorization reduces to a single allowlisted account identifier held in an environment variable. No user table, no session store, no role model.

That identifier is the owner's **numeric GitHub user id**, not their username. Usernames can be changed and re-registered by someone else; the numeric id is stable for the life of the account. It is resolvable before deployment by an unauthenticated call to `https://api.github.com/users/<username>`, which the deploying agent makes on the owner's behalf. This is why the design needs no bootstrap mechanism at all: the value is knowable in advance, so it is simply set as configuration.

An earlier draft proposed an "identity echo" endpoint that completed OAuth and returned callers their own identifier, because a Google subject id cannot be known in advance. With Google gone, so is the problem it solved, and the endpoint is removed. It was the weakest part of the design: it exposed an unauthenticated OAuth relying party to the internet, advertised the instance as unclaimed, and asked a human to verify an opaque number by eye.

Authorization is checked **on every MCP request**, against the identity bound to the presented token, and not only at sign-in. Revoking access has to mean the next request fails, not the next login. Changing the owner allowlist invalidates existing grants.

Three details make that sentence mean what it should, and each is easy to get wrong by following a template:

- **The check reads a stored numeric id, never GitHub.** At consent time the numeric id is written into the grant's props; each request compares that stored id against the current environment variable. It does not call GitHub per request, which would spend a 5,000-per-hour quota on routine tool calls and add a network round trip to every one.
- **Only the numeric id is persisted. The GitHub access token is discarded** as soon as the callback has resolved the identity. It has no further purpose, and Cloudflare's `workers-oauth-provider` examples stash upstream tokens in grant props, so an implementer following the template ends up with the owner's live GitHub credential sitting in KV on an instance whose entire security argument is one environment variable.
- **No GitHub scopes are requested.** `https://api.github.com/user` returns the numeric id with an unscoped token. Asking for `read:user` by reflex widens both the consent screen shown to the stranger this project is trying not to lose and the blast radius if anything leaks.

Two consequences worth writing down rather than discovering. Revoking a grant means clearing the KV namespace, which also removes the dynamically registered Claude client, so the owner has to add the connector again. And KV is eventually consistent, so a deletion can take a minute or more to propagate; comparing the stored id against the current allowlist variable on every request is what makes revocation-by-allowlist-change immediate, rather than the KV delete.

### Failing closed

The Worker fails closed. If the owner allowlist variable is unset, or the GitHub client id or secret is missing, or the cookie encryption secret is missing, it refuses to serve tools at all. The worst plausible outcome of a careless deploy is a stranger's contact list on the open internet, and that state must be unreachable by omission rather than by a check someone remembered to write.

### Onboarding sequence

The supported order is: deploy the Worker, add the connector once on claude.ai or Claude Desktop, and only then use it from the phone.

That order was checked against Anthropic's documentation on 2026-08-21 rather than left open. Web connectors work on Claude Mobile for iOS and Android; **installing** a connector from mobile is in beta, and Anthropic names Claude Desktop and the web as the primary path for custom connectors. So the runbook documents web or desktop as the supported path and describes mobile installation as beta rather than impossible. A user who starts on mobile may succeed, and if they hit a wall the runbook has already told them where the supported path is.

The connector is named `Junco PRM`. Two separate names are involved and the runbook has to set both consistently, because the project controls neither directly. Claude prompts the human to type a connector name when adding it, and GitHub separately controls the name shown on the OAuth consent screen, which comes from the OAuth application the deployer registers.

Free-plan Claude users are limited to one custom connector, which is worth noting when handing this to someone.

This sequence is the tail of the deploy runbook rather than a separate document. See Deployment.

## Deployment

Deployment is the whole product for anyone who is not the author. A PRM nobody can stand up is a demo. The deploy path is therefore designed as a document an agent executes rather than a tutorial a person reads, because the party handing this to a stranger is increasingly an LLM sitting in that stranger's terminal.

### The target

Four human blocks. Two earlier drafts claimed two and then three; both were wrong, and the third one was wrong in a way worth recording, because it hid a human step inside a step labelled agent work.

1. **Sign in to Cloudflare.** `wrangler login` opens a browser and waits.
2. **Choose a `workers.dev` subdomain.** The first deploy on a fresh account prompts for one interactively, and it is globally unique, so a name can be taken and the human has to pick another. A prior draft counted this as agent work. It is a person sitting at a terminal choosing a name.
3. **Register the GitHub OAuth application and paste the secret.** One browser visit, one paste into a waiting terminal prompt. It is an **OAuth App**, under Developer settings, and specifically not a GitHub App: GitHub's interface pushes the latter harder, it is a different flow with a different token model, and both strangers and agents pick it by mistake. The runbook gives the literal navigation path and the exact callback URL, constructed and printed by the agent, because a stranger who pastes the bare Worker URL gets a flow that fails at consent time with an unhelpful error.
4. **Add the connector and approve it.** Add it on claude.ai or Claude Desktop, then approve the GitHub consent screen on first connect. On Team and Enterprise plans only an organization owner can add a custom connector, which the runbook has to say out loud rather than let someone discover.

Everything around and between those is agent work: cloning, installing dependencies, creating the D1 database and the KV namespace, writing the resulting ids back into the Wrangler configuration, applying migrations, resolving the owner's GitHub user id, setting non-secret variables, deploying, and verifying the result.

Setting the owner identity is not a human block. The agent resolves the numeric GitHub user id from a username it was given, so nothing is copied out of a browser.

### Why the remaining steps cannot be automated away

Recorded so that nobody spends a day trying.

- Cloudflare authentication is an interactive browser flow. The API-token alternative still needs a human in the dashboard to mint the token, so `wrangler login` is the simpler of two human steps rather than an avoidable one.
- `wrangler login` cannot complete on a headless or SSH host with no local browser, which is a common place for an agent to be running. The runbook documents the `CLOUDFLARE_API_TOKEN` branch for that case rather than assuming a desktop.
- GitHub exposes no API for creating an OAuth application. It is browser-only by design. This is the largest block of unavoidable human time in the whole deploy, and cutting Google removed the second one.
- A client secret is displayed once, in a browser. The runbook has the human paste it straight into a `wrangler secret put` prompt rather than reading it out to the agent. That is deliberate. A secret typed by an agent is a secret written into a transcript, and transcripts are retained and synced. This is the one place the section trades against its own goal, and it trades correctly.
- Custom connectors are added through the Claude interface, not through an API.

### Ordering

Agent work is pulled forward, and human work is batched into contiguous blocks rather than interleaved, because a context switch costs a person far more than a command costs an agent.

One constraint drives the ordering. The GitHub OAuth application needs the Worker's callback URL, and that URL is not known until the Worker has a name and the account has a `workers.dev` subdomain.

An earlier draft claimed the URL could be computed before any deploy, by reading the account subdomain from Cloudflare's API. That is true only for an account that already has a subdomain, and a brand new account does not: the subdomain is registered during the first deploy, and the target user here is a stranger on a fresh account, so the unset case is the common one rather than the edge case. Wrangler also has no command that reads the subdomain back, so computing it means calling the REST API directly with a credential that `wrangler login` does not conveniently expose.

The ordering is therefore **deploy a stub first**. The agent deploys a Worker that serves only `/health`, with no OAuth and no tools, which fails closed by construction because there is nothing there to serve. `wrangler deploy` prints the real URL. The agent reads it from that output, and the human then registers the GitHub OAuth application once against a URL that is known to be correct. It also fixes a second ordering problem it does not advertise: `wrangler secret put` needs the Worker to exist.

Worker names are unique per account, not globally; the globally unique thing is the `workers.dev` subdomain, and the stub deploy does not remove that collision, it relocates it to a step where a human is already present. An earlier draft claimed otherwise.

The Worker name and the subdomain become immutable OAuth configuration once that application exists. Renaming the Worker later breaks the callback, and the runbook says so.

### Runbook shape

A single file, `docs/DEPLOY.md`, is the deliverable, and it is written to a fixed structure rather than as prose:

- Every step is numbered and tagged `agent` or `human`. No step is ambiguous about who acts.
- Every `agent` step carries its exact command, the expected output, and what to do when the output does not match. Failure branches key off exit status and structured output, using `--json` wherever Wrangler offers it. They do not match on human-readable error prose, which changes between releases and would rot silently.
- Wrangler and every dependency version is pinned, and so is a minimum Node version. A runbook written against unpinned tooling is a runbook that worked once.
- A fresh Cloudflare account must have its email verified before deploys succeed, which is a step that happens in an inbox and blocks everything after it.
- Migrations are written `wrangler d1 migrations apply --remote` in the literal command text. The flag defaults to local, an agent will omit it, and the resulting failure looks like success.
- Every `human` step says exactly what to open, what to click, what to paste, and what to copy back, because the agent cannot see the browser and cannot infer that a page has changed.
- Every `agent` step is idempotent and safe to re-run. Agents retry, so a half-finished deploy has to be resumable rather than restartable. `wrangler d1 create` against a database that already exists is an expected condition to be caught, not a failure.
- A "state to carry" block names every value collected so far, explicitly rather than by description: Cloudflare account id, Worker name, `workers.dev` subdomain, the deployed URL, the D1 `database_id`, the KV namespace id, the GitHub OAuth client id, whether each secret has been set, the owner's numeric GitHub user id, `OWNER_TIMEZONE`, the applied schema version, and the connector registration state.
- **Four URLs are named literally,** not described. The Worker base URL, the MCP endpoint, the GitHub OAuth callback, and Anthropic's callback that the dynamically registered client uses. "The deployed URL" is ambiguous between the first two, and the GitHub application needs the third exactly.
- `database_id` and the KV namespace id are called out separately because both are printed by a create command and must be **written back into the Wrangler configuration file**. Forgetting that write-back is the classic breakage in this kind of deploy, and an agent that treats the create command as the end of the step will produce a Worker that deploys cleanly and cannot reach its own database.
- `wrangler secret put` deploys a new Worker version as a side effect, so the runbook fixes the order in which secrets and deploys happen rather than leaving it to chance.
- The document ends in an agent-runnable verification rather than in congratulations.

### Verification

Verification runs in two parts, because unauthenticated checks cannot prove the thing that actually matters.

The agent asserts that the Worker responds, that it refuses tools when unauthenticated, and that migrations are applied. This needs an endpoint that the spec has to define rather than assume: `/health`, unauthenticated, returning `{ok, schema_version, owner_configured}` and nothing else. It deliberately does not report whether the instance is unclaimed in a way that invites claiming, since with the owner id set as configuration before first deploy there is no unclaimed window to advertise.

That is not sufficient on its own. Reachability and a refused anonymous request say nothing about whether the owner can actually sign in, whether the GitHub application is configured correctly, or whether Claude can complete a connection. The runbook therefore ends with an **authenticated** end-to-end check: connect the connector, call one harmless read tool, and confirm a real result comes back. Fail-closed is confirmed rather than assumed, and so is fail-open.

### Relationship to the deploy button

A one-click "Deploy to Cloudflare" template can now provision and bind both D1 and KV and run migration scripts, which covers more of the runbook than an earlier draft assumed. It still cannot register a GitHub OAuth application and cannot set the owner allowlist. It is therefore a shortcut used from inside the runbook rather than an alternative to it, and the runbook stays the supported path.

## Security and data handling

- TLS in transit, Cloudflare's encryption at rest, and account isolation.
- No application-layer encryption of note text. Encrypted text cannot be searched with FTS5, and the threat model is the user's own Cloudflare account rather than a shared host. This is a deliberate trade, not an oversight.
- No compression. A PRM database is single-digit megabytes.
- **Imported roster text is untrusted input.** It is written by strangers, it is fetched from the public web, and it is read back to an agent that can call write tools. A roster row whose job title reads like an instruction is the obvious prompt-injection vector, and it costs nothing to design against now. Tool results mark imported and stored free text as data rather than presenting it as narration, and the tools that act destructively require an explicit id plus a confirmation token, so injected text cannot cause a write on its own.
- **Rate limiting on the unauthenticated surface.** The OAuth authorization, token, dynamic-registration, and `/health` routes are reachable by anyone who finds the URL. Unlimited, they burn Worker requests, D1 reads, and the deployer's own GitHub application quota. An earlier draft called for "a Cloudflare rate-limiting rule," which cannot be written at all here: WAF rate-limiting rules are authored per zone, and a `workers.dev` deployment has no zone in the deployer's account. What the template can actually ship is the **Workers rate-limiting binding**, declared in `wrangler.jsonc` and enforced in code. Two honest caveats: Cloudflare describes it as permissive and eventually consistent rather than exact, so it is protection against burning quota and not an accounting mechanism; and it runs inside the invocation, so it cannot protect the 100,000-requests-per-day Worker quota itself, only the D1 and GitHub work behind it.
- **Dynamic Client Registration is an unauthenticated write.** Anyone who finds the URL can register clients in a loop. Rate limiting covers the volume; constraining accepted redirect URIs to Anthropic's documented callback closes the rest.
- **Imported roster text never leaves the staged tables as raw content.** `raw_record` is stored and available through provenance, and it is not returned in ordinary search results. Marking hostile text as data is a convention, not a boundary, and the cheapest boundary available is not putting a stranger's free text in front of the model during a routine search.
- **Authentication failures are logged** with the presented numeric id. The logging rule below forbids PRM content, not security events, and a rejected identity is the only signal that someone is probing the instance.
- **Logs never contain PRM content.** Structured logs carry tool name, duration, outcome, and a request id. They do not carry names, note text, or tokens. Workers observability is enabled in the Wrangler configuration so that a deployed instance is debuggable at all, and that only helps if the logs are safe to read.

## Failure modes

- **A write against the wrong person** is the failure that will actually happen. Mitigated by disambiguating context in search results, by `search_people` returning people and roster entries in separate arrays so the two cannot be confused, by writes taking a prefixed person id rather than a name, by prefix validation rejecting a roster entry id where a person id belongs, and by every write echoing the full affected record. Echoing the record detects the mistake; it does not prevent it, which is why the id discipline above carries the weight.
- **Bad merges** are avoided by having no merge tool in v1. `promote` either links to an existing person or creates a new one, and duplicates are tolerated. A tolerated duplicate is cheap; an unreversible bad merge is not. The gap this leaves is real and is named rather than hidden: two duplicate records that both have encounters attached cannot currently be reconciled, and that is the case a merge tool will eventually be designed against.
- **Import duplication** is prevented by a unique constraint on `(roster_source, external_row_key)`, so a re-run updates rather than duplicates.
- **D1 limits during import** are handled by making import resumable across tool calls rather than chunked within one, because the binding free-plan limit is 50 D1 queries per Worker invocation and chunking inside an invocation does not move it.
- **Duplicate writes from client retries** are prevented by the optional `idempotency_key` on every write, and by import chunks being idempotent on `(run_id, offset)` whether or not a key was supplied.
- **A caller asserting completeness** is no longer a failure mode, because nothing acts on such an assertion. Retirement was the only place a claim about the outside world could destroy data, and it was removed on 2026-08-21.
- **Schema migrations** run through Wrangler's D1 migrations, applied with `--remote`, and user-deployed instances must apply them on deploy. `/health` reports the applied schema version so drift is detectable rather than mysterious.

### Backup and restore

An earlier draft said data loss "is covered by `wrangler d1 export` plus an `export_data` tool." Both halves were wrong.

`wrangler d1 export` does not support a database containing virtual tables, and FTS5 tables are virtual tables. The command that the spec named as the backup does not run against the schema the spec specifies.

`export_data` was also never in the tool list, so the surface was either larger than stated or the sentence was wrong. And returning the entire PRM through a tool result pushes the whole durable dataset into a conversation transcript, which is a strange thing to do deliberately. Anthropic's tool results are also capped at roughly 150,000 characters, so the export would truncate or fail exactly when there is enough data to be worth saving.

Backup is two layers, and neither of them is a single tool call:

- **D1 Time Travel** for short-term recovery: point-in-time restore, 7 days on the free plan and 30 days on paid, already on and needing no setup. This covers the overwhelmingly common case, which is a bad write ten minutes ago, and it covers it without anyone having remembered anything in advance.
- **A durable-data export run from the CLI to the operator's own machine,** not through Claude and not into another Cloudflare service. It selects the durable source tables explicitly, excludes the FTS5 virtual tables, and writes JSON to a local path the operator chooses. The FTS indexes are repopulated from the restored source tables rather than backed up, because they are derived data; with standalone FTS tables that means reinserting rows, not issuing a `rebuild` command, which only external-content tables understand.

  The export is a file someone will one day have to trust, so its shape is specified rather than left to the implementer: a manifest carrying schema version, application version, export timestamp, and per-table row counts and checksums; tables written in dependency order; the file created atomically and with restrictive permissions. And a caveat that a table-by-table export cannot avoid: unlike Cloudflare's native export, it does not block other requests, so a write landing mid-export can leave two tables describing different moments. For a single-user PRM whose operator is running the export themselves, that is acceptable and it is written down rather than glossed.

The restore is not a third layer, it is a property the second one has to have: **an export nobody has ever restored is not a backup.** Restoring into an empty database and comparing the result against the source is part of testing, not something documented and hoped for. It is also re-run whenever the schema changes, because an export format that has not been restored since the last migration is back to being untested.

Nothing runs the export on a schedule. That was an open question, and on 2026-08-21 it was settled as a local export the operator runs, rather than a Worker cron writing to R2. R2 keeps the copy inside the same Cloudflare account, so it protects against a bad migration and not against the case the export exists for, and it adds a binding, and probably billing details, to a deploy this project is trying to keep within reach of a stranger. The deploy documentation names a cadence and says plainly what is lost if nobody follows it.

`export_data` survives as a paginated convenience tool for "give me my data," with an explicit scope and cursor. It is not the backup story and the spec no longer calls it one.

Time Travel lives inside the user's Cloudflare account and does not survive the loss of it. The local export is the only thing that does, which is the whole argument for running it. See Operations.

## Operations

The spec previously stopped at deploy, which is the point where a self-hosted instance starts having a life.

### Time zones

Workers run in UTC. `set_followup` and `list_due` deal in dates, and "follow up tomorrow," typed from a phone in Pacific time, is wrong for roughly a third of every day if the server assumes its own clock.

The deployment carries an `OWNER_TIMEZONE` variable set at deploy time. Timestamps are stored as UTC instants; due dates are stored as local date strings and interpreted in the owner's zone. This is small to get right now and unpleasant to retrofit once there is data.

### Upgrading an existing instance

A user who deployed in March and hears about a fix in June has no mechanism to get it. `docs/UPGRADE.md` covers it: pull, install with a lockfile, apply migrations with `--remote`, deploy, and confirm the schema version through `/health`. Migrations are backward-compatible within a major version, and a pre-migration Time Travel bookmark is recorded before any migration runs.

### Cost

The first question a stranger asks is whether this will cost them money, and an unanswered version of that question is a reason not to deploy. The deploy documentation answers it with numbers: the free plan is sufficient for this workload, and the limits that bind are 500 MB per database, 10 databases per account, 50 D1 queries per Worker invocation, 10 ms CPU per invocation, and 100,000 Worker requests per day.

### Losing access

Three different losses with three different answers, stated plainly because the honest answer to one of them is bad:

- **Losing the GitHub account** is recoverable. Resolve the new numeric user id, update the allowlist variable, redeploy. Existing grants are invalidated by the allowlist change.
- **A leaked client secret** is recoverable. Rotate it at GitHub, set it again with `wrangler secret put`, and revoke outstanding grants by clearing the KV namespace.
- **Losing the Cloudflare account** is not recoverable from inside the system. Everything lives there, including Time Travel. The exported JSON on the operator's own machine is the only answer, and nothing automates it: the coverage is exactly as good as the operator's habit of running it. The deploy documentation says that in those words rather than implying a safety net that does not exist. An operator who never runs the export has no answer to this case, and should know that before they have data worth losing.

## Testing

- Tool functions are pure over a D1 handle and unit test against local D1 under Wrangler.
- Contract tests pin each tool's input and output shape.
- One end-to-end path against a small committed fixture of a few hand-built rows: import the roster, promote a person, log an encounter, set a follow-up, list what is due. The fixture is invented test data rather than an extract of anyone's real roster, which keeps the loop fast and the test repeatable.
- Import at scale is tested separately and deliberately, outside the e2e loop. The WCUS prototype's 798 rows are the scale case that exercises the resumable import protocol against D1's per-invocation query limit, and that run happens once promote and duplicate-candidate behavior are already proven against the fixture. Its 11 duplicated names over 23 rows make it the duplicate-candidate fixture as well.
- The deploy runbook is tested by executing it end to end against a fresh Cloudflare account. A runbook that has not been run since it last changed is an untested runbook, and the failure it produces lands on a stranger rather than on us.
- A fail-closed authorization test is non-negotiable. It covers an unset owner allowlist, a missing GitHub client id or secret, and a missing cookie encryption secret. It also covers a valid token belonging to the wrong GitHub account, checked per request rather than only at sign-in.
- An authenticated end-to-end test against a real deployed instance through Claude. Local tests cannot exercise Dynamic Client Registration, the consent screen, or token refresh, which is where a connector actually fails.
- A restore drill. The durable export is restored into an empty database and the result is compared against the source, because an untested restore is not a backup.
- Idempotency and retry tests. The same write replayed with the same `idempotency_key` produces one record, and a re-import of an unchanged roster produces zero new rows.
- Id-prefix validation tests. Passing a roster entry id where a person id belongs is rejected rather than written.
- A measurement, not a test, run before the import code exists: does a `db.batch()` of N statements count as N queries or as one subrequest against the free-plan limit? See Open questions. The chunk size depends on the answer and the documentation does not settle it.
- Promotion idempotency. Promoting the same roster row twice returns the same person and creates nothing, including after that roster has been purged and imported again, which is the path `person_sources` exists to keep working.

## Phasing

- **Phase 1** - Worker, D1, and the `OAUTH_KV` namespace; GitHub OAuth; the tool surface; migrations; the deploy template; and the agent-executable deploy runbook covering the web-first connector setup.
- **Phase 2** - a read-only self-contained HTML export of durable data, which doubles as the shareable demo artifact and needs no hosting.
- **Later, only if wanted** - a second identity provider, extracted against two real implementations rather than one; an optional local stdio adapter over the same tool module; and a merge tool designed against real duplicate data.

## Research findings, as of 2026-08-20

These were verified during design and should be re-checked if implementation starts much later.

- D1 supports the FTS5 module including `fts5vocab`: https://developers.cloudflare.com/d1/sql-api/sql-statements/
- Remote MCP connections originate from Anthropic's servers, not the user's machine; custom connectors are available on Free, Pro, Max, Team, and Enterprise, with Free limited to one: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Claude Mobile, iOS and Android, can use web connectors, and **installing** a connector from mobile is in beta, with Claude Desktop and the web named as the primary path for custom connectors. Checked 2026-08-21, which resolved what the first two drafts recorded as contradictory: https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities and https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- A note in an earlier draft claimed Anthropic documents fixed bearer tokens via connector request headers. Re-checking on 2026-08-21 did not find that on the cited page, whose advanced settings describe an OAuth client id and secret only. The claim is withdrawn rather than carried forward unverified. OAuth stays regardless; if a header-token path does exist or arrives later it would remove the entire authentication section, which makes it worth re-checking before plan 2 rather than assuming either way.
- D1 export does not support databases containing virtual tables, which includes FTS5. The backup design under Failure modes is written around this: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- Relevant D1 free-plan limits: 500 MB per database, 2 MB per row, 100 bound parameters per query, 100 KB per SQL statement, 30 seconds per query or batch, and 50 D1 queries per Worker invocation. Free Workers also allow 10 ms CPU per invocation: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare `workers-oauth-provider` and the remote MCP server template: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/ and https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/

## Questions resolved on review

The first draft closed with three open questions. Matt answered all three on 2026-08-20, and the sections above are written to match. Recorded here so the reasoning is not lost.

- **Identity provider:** GitHub only. Answered first as "both, chosen at deploy time," then reversed on 2026-08-20 after a multi-agent review of the spec came back unanimously against carrying two providers into phase 1. Google's cost is concentrated in exactly the place the project can least afford it, the deploy a stranger performs, and supporting both would have doubled the end-to-end test matrix before either path was proven once. The provider seam went with it, on the grounds that an interface with one implementation is not an abstraction. See Authentication and Layering.
- **First import:** a small committed fixture first. The WCUS prototype's 798 rows are held back as a separate scale test rather than being the first import. See Testing.
- **Connector display name:** `Junco PRM`. See Onboarding sequence.

## Questions resolved on 2026-08-21

A four-agent review of the phase 1 implementation plan surfaced four decisions the plan could not take on its own. Matt took them on 2026-08-21 and the sections above are written to match.

- **Import protocol:** each call carries only its own chunk. The contract previously took the entire `rows` array on every call and sliced it server-side, which re-transmitted a 798-row roster six times through the model, in direct contradiction of this spec's own argument for parsing on the server. The first call now declares `expected_total`, later calls carry `run_id` and an in-order `offset`. See `import_roster` is resumable across calls.
- **`people.notes` stays, with a job.** It holds standing facts that remain true between meetings; encounters hold what happened on a date. Left undifferentiated, the two were a drift waiting to happen. See Data model.
- **Backup is a local CLI export the operator runs,** not a Worker cron writing to R2. R2 leaves the copy in the same account it is meant to survive, and it adds a binding and probably billing details to a deploy aimed at a stranger. See Backup and restore, and Losing access, which now says what happens to an operator who never runs it.
- **Mobile connector installation is beta, not impossible.** Checked against Anthropic's documentation rather than left as an open question. See Onboarding sequence.

## Decisions taken on the spec review, 2026-08-21

A three-agent review of this spec ran the same day; a fourth agent timed out. Every reviewer that returned independently found the same defect first, which is the strongest signal this project has had about anything.

- **Roster retirement is removed.** `finalize_import(full_coverage: true)` marked rows the run had not seen as retired, gated on the caller's declared row count. All three reviewers showed the same hole: an agent whose input was truncated declares the total it can see, satisfies every check, and destroys hundreds of current rows silently. The earlier hash-based version had the identical hole, because a hash proves the caller consistent with what it sent, never that what it sent was complete. Retirement was the only path by which a claim about the outside world could destroy data, and a stale roster is replaced by purge-then-import instead. See Import identity.
- **`person_roster_entries` is dropped.** It was classified durable while pointing at staged rows, so purging a roster either cascaded into durable data or left the backup carrying references to data it does not contain. `person_sources` already stores the source key and external row key, so the promotion link is derived from durable provenance and survives a purge and a later re-import. See Data model.
- **Nine tools were added to the surface**, which had no way to record an email address, no `delete_person` despite this spec arguing at length that one must exist, and no `finalize_import` or `export_data` despite both appearing in its own prose. The count is now stated honestly: 26 named tools. See MCP tool surface.
- **`search_people` returns two named arrays** rather than one list with a discriminator, because this spec names a write against the wrong person as its most likely real failure and an agent cannot confuse records that never share an array.
- **`create_person` checks for duplicates** against people and roster entries, and refuses on a strong match without `force`. Otherwise the most common sentence at a conference silently creates a durable duplicate of a roster row and loses its provenance.
- **Authentication gained three specifics** that a template would get wrong: the per-request check reads a stored numeric id rather than calling GitHub, the GitHub token is discarded once the id is known, and no scopes are requested.
- **The rate-limiting plan was wrong** and is corrected: a WAF rule cannot be written for a `workers.dev` deployment with no zone. The Workers rate-limiting binding can, with its own caveats.
- **The deploy count went from three human blocks to four.** Registering a `workers.dev` subdomain is an interactive prompt on a fresh account, and a prior draft counted it as agent work.
- **The fixed-bearer-token research note was withdrawn** as unverified rather than carried forward.

## Open questions

One, and it is empirical rather than a design choice.

**Does each statement inside a `db.batch()` count individually against D1's 50-query free-plan limit, or does a batch count as one subrequest?** Cloudflare's limits page states that per-statement limits apply inside a batch and is silent on subrequest counting. Two reviewers read it strictly, one read it as a single subrequest. The import chunk size derives from the answer. The strict reading is assumed here because it fails safe, and it is measured against a real Worker in the first implementation task; the numbers in this spec change if the measurement disagrees.

Everything else the first four drafts left open has been answered above. The remaining uncertainty is not a question but a condition: nothing here has been run. The claims about D1 behavior, FTS5 under D1, and the deploy sequence are researched rather than observed, and the first execution of plan 1 is what turns them into facts.
