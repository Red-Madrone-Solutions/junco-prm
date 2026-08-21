# Junco PRM - Design

- Date: 2026-08-20
- Status: draft, under review. Nothing is implemented.
- Revised 2026-08-20, twice: first to record the three answers from Matt's review, then again after a four-agent independent review of the spec. The second pass reversed the two-provider decision, deleted the identity-echo mechanism, corrected several platform facts, and rewrote the data model, tool surface, and backup design. Decisions and their reversals are recorded in "Questions resolved on review" at the end.
- Revised again 2026-08-21, after a four-agent review of the phase 1 implementation plan sent four questions back up to the spec. The import protocol now sends each row once instead of re-transmitting the roster on every call, `people.notes` has a stated job, the backup is a local export rather than an undecided one, and the mobile-connector question was checked rather than deferred. See "Questions resolved on 2026-08-21" at the end. There are now no open questions.
- Author: Matt (Red Madrone Solutions), drafted with Claude

## Summary

Junco PRM is a small, single-user personal relationship manager whose primary interface is an MCP server rather than a web UI. It is deployed by each user to their own Cloudflare account as a Worker backed by D1 and a KV namespace, so the operator of the project hosts nothing and never receives anyone's data. Because remote MCP connectors work on Claude mobile, a deployed instance is usable from a phone, which is the requirement that drove the hosting decision.

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
- `encounters` - person, when, where, event, summary, plus `created_at` and a nullable `deleted_at`.
- `followups` - person, due date, note, `completed_at`, `cancelled_at`.
- `person_sources` - durable provenance, copied at promotion time rather than referenced: source key, external row key, `source_url`, `source_captured_at`, and a snapshot or hash of the raw record.
- `person_roster_entries` - the many-to-many link between a person and the staged rows they were promoted from.

### Staged tables

- `roster_sources` - a logical roster that can be imported more than once: stable key, label, event, URL.
- `import_runs` - one attempt against a source: timestamp, input hash, format, status, and counts of inserted, updated, retired, and skipped rows.
- `roster_entries` - the imported row: its source, its `external_row_key`, the person fields as imported, the prototype's `source_url`, `source_captured_at`, and `raw_record` unchanged, the run that last saw it, and a `retired_at`.

### Why provenance is three tables and not one column

An earlier draft used a single `source_key` on `roster_entries` and a pair of pointers, `people.promoted_from_roster_entry_id` and `roster_entries.promoted_person_id`. Three separate defects, all cheap now and expensive after real data exists:

- **`source_key` had to mean two things at once.** If it identifies a roster, a re-import overwrites the record of the earlier capture. If it identifies a particular run, idempotency across runs fails. It cannot do both, so it is split into `roster_sources` and `import_runs`.
- **The pointer pair cannot represent one person on two rosters,** which is the normal case for anyone attending a conference twice. It also stores the same relationship in two places, so the two drift. It becomes `person_roster_entries`.
- **Durable data pointed at disposable data.** The staged tables are explicitly described as re-fetchable and are not backed up, yet a person's only provenance lived there. Promotion now copies provenance into `person_sources`, so purging a roster never strips a person of their origin.

### Import identity

Idempotency is on the pair `(roster_source, external_row_key)`, with a unique constraint enforcing it, so a re-run updates rather than duplicates.

`external_row_key` comes from the source when the source has one. When it does not, as with pasted text, it is the SHA-256 of the normalized row content. It is never the person's name: the prototype roster contains 11 duplicated names covering 23 rows, so a name is not an identity.

A re-import must also distinguish a row that vanished from the source from a row that was merely absent from a partial paste. Rows not seen by a run that claims full coverage are marked `retired_at` rather than deleted, and retirement never touches a promoted person.

### Search

Search uses FTS5 with bm25 ranking. Two indexes, not one, because people and encounters are different entities and conflating them produces results an agent cannot explain: one over `people` (names, organization, job title, notes) and one over `encounters` (summary). Both are external-content FTS5 tables kept in sync by SQLite triggers declared in the migrations, so application code cannot forget to update them.

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

1. `search_people` - FTS5 search over names, organization, title, tags, and note text. Returns matches with organization and last encounter inline so the agent rarely needs a second call. Takes an explicit `scope` of `contacts`, `roster`, or `all`, never a boolean flag, and every result carries a mandatory `record_kind`.
2. `get_person` - the record in one call: contacts, links, tags, open follow-ups, provenance, and recent encounters with a total count. Encounter history paginates rather than promising every encounter forever.
3. `list_encounters` - by person, event, or date range. Answers "who did I meet at WordCamp," which is a top-three conference question that `search_people` cannot answer.
4. `list_due` - open follow-ups, overdue first. The tool that answers "what am I forgetting."
5. `list_roster_sources` - what has been imported, when, and how much of it has been promoted.

### Writes

6. `create_person` - creates. Fails if it would need an id.
7. `update_person` - updates. Requires an explicit person id.
8. `archive_person` - sets `archived_at`, which previously existed as a column no tool could set.
9. `log_encounter` - person, when, where, what happened, optional follow-up. The highest-frequency write.
10. `update_encounter` and `delete_encounter` - correct or remove a mis-logged encounter. Delete here is hard delete, because the point is to erase a mistake.
11. `set_followup`, `complete_followup`, `cancel_followup` - what is owed to someone, closing it out, and dropping it.
12. `import_roster` - see below.
13. `promote` - two calls, not one. See below.
14. `purge_roster_source` - removes a staged source and its entries. Promoted people and their copied provenance are untouched.

`create_person` and `update_person` replace a single `upsert_person`. Requiring an explicit id for updates was right and is kept; the name was the problem. "Upsert" invites an agent to assume the server will match on name, and this server never matches on name.

### Id discipline

Every id is prefixed by kind and every tool validates the prefix: `p_` for a person, `re_` for a roster entry, `enc_` for an encounter, `fu_` for a follow-up, `rs_` for a roster source.

This is not cosmetic. `search_people` can return two entity kinds, and the failure the spec names as most likely, a write against the wrong person, arrives most easily by an agent passing a roster entry id into `log_encounter`. A prefixed id makes that a validation error instead of a corrupted record.

### `promote` is two-phase

Surfacing duplicate candidates and committing a promotion cannot happen in one call, because the agent has to see the candidates before choosing.

- `promote(roster_entry_id)` writes nothing and returns duplicate candidates with the evidence for each.
- `promote(roster_entry_id, link_to_person_id | create_new: true)` commits, and copies provenance into `person_sources`.

### `import_roster` is resumable across calls

An earlier draft passed a whole CSV through one tool call and described "chunked writes with progress reported back." That does not work, for two separate reasons.

The first is a platform limit. D1 allows 100 bound parameters per query and, on the free plan, 50 queries per Worker invocation. `roster_entries` has roughly a dozen columns, so a multi-row insert carries about 8 rows, and 798 rows is roughly 100 statements. Chunking inside one invocation does not help, because the cap is per invocation. Free Workers also allow 10 ms of CPU per invocation, which parsing a large CSV can exceed on its own.

The second is that an MCP tool call is one-shot. There is no channel for a server to report progress during a call, so "progress reported back" was not implementable as written.

Import is therefore a protocol, and the tool contract says so:

- `import_roster(source_key, label, source_url, format, rows, expected_total?, run_id?, offset?)` returns `{run_id, imported, updated, skipped, errors, next_offset, remaining}`. The agent loops until `remaining` is zero, then calls `finalize_import`.
- **The first call declares `expected_total`** and carries the first chunk. The server opens a run recording that total, and every later call carries `run_id`, the `offset` it is continuing from, and only its own chunk.
- **`offset` must equal the run's `next_offset` exactly.** A call that skips ahead is refused rather than accepted, because a gap plus a later full-coverage finalize would retire rows that are perfectly current and were simply never sent.
- Each call is capped at a server constant well under the free-plan limits, on the order of 150 rows. A chunk larger than the cap is **rejected, not truncated**: the agent decides the chunking, so silently dropping the tail would lose rows without anything saying so.
- Parsing CSV and JSON is deterministic server code, and the agent sends each row exactly once across the whole run. An earlier version of this contract took the entire `rows` array on every call and sliced it server-side, which meant a 798-row roster crossed the model six times. That was decided against on 2026-08-21.
- A run can be previewed before it commits, and reports validation errors per row rather than failing whole.

**What the server can and cannot verify about a resumed run.** It checks that the run exists and is open, that it belongs to the source and format being imported, that the offset is the one expected, and that a replayed chunk carrying the same `idempotency_key` returns its original result instead of advancing twice. It cannot verify that the chunk in front of it comes from the same roster the run was opened against, because it no longer sees the whole input. Retirement therefore rests on the declared count: `finalize_import` accepts `full_coverage` only from a run whose committed rows equal its `expected_total`. That is a weaker guarantee than hashing the whole input, and it is the price of not re-transmitting the roster on every call.

### Rules that make this LLM-first

- Returns are rich, so one call usually suffices.
- Every write returns the full affected record, so mistakes are visible in the transcript immediately.
- Every write takes an optional `idempotency_key`. Mobile connections drop, clients retry, and a retried `log_encounter` must not produce a second encounter.
- Destructive operations use an explicit two-call protocol: the first call returns a preview and a confirmation token, the second call presents that token. An earlier draft said destructive things "propose and wait for confirmation," which a one-shot tool call cannot do. The client's own approval UI is a second layer, not a substitute.

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

Three human blocks. An earlier draft claimed two, which was wrong: counting the real browser interactions under OAuth gives five, and the honest target is how few contiguous blocks they can be batched into rather than how few interactions can be claimed.

1. **Sign in to Cloudflare.** `wrangler login` opens a browser and waits.
2. **Register the GitHub OAuth application and paste the secret.** One browser visit, one paste into a waiting terminal prompt.
3. **Add the connector and approve it.** Add it on claude.ai or Claude Desktop, then approve the GitHub consent screen on first connect.

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

The ordering is therefore **deploy a stub first**. The agent deploys a Worker that serves only `/health`, with no OAuth and no tools, which fails closed by construction because there is nothing there to serve. `wrangler deploy` prints the real URL. The agent reads it from that output, and the human then registers the GitHub OAuth application once against a URL that is known to be correct. This costs one extra agent step and removes the subdomain-registration case, the API-plumbing case, and the globally-unique-worker-name collision case at the same time.

The Worker name and the subdomain become immutable OAuth configuration once that application exists. Renaming the Worker later breaks the callback, and the runbook says so.

### Runbook shape

A single file, `docs/DEPLOY.md`, is the deliverable, and it is written to a fixed structure rather than as prose:

- Every step is numbered and tagged `agent` or `human`. No step is ambiguous about who acts.
- Every `agent` step carries its exact command, the expected output, and what to do when the output does not match. Failure branches key off exit status and structured output, using `--json` wherever Wrangler offers it. They do not match on human-readable error prose, which changes between releases and would rot silently.
- Wrangler and every dependency version is pinned. A runbook written against unpinned tooling is a runbook that worked once.
- Migrations are written `wrangler d1 migrations apply --remote` in the literal command text. The flag defaults to local, an agent will omit it, and the resulting failure looks like success.
- Every `human` step says exactly what to open, what to click, what to paste, and what to copy back, because the agent cannot see the browser and cannot infer that a page has changed.
- Every `agent` step is idempotent and safe to re-run. Agents retry, so a half-finished deploy has to be resumable rather than restartable. `wrangler d1 create` against a database that already exists is an expected condition to be caught, not a failure.
- A "state to carry" block names every value collected so far, explicitly rather than by description: Cloudflare account id, Worker name, `workers.dev` subdomain, the deployed URL, the D1 `database_id`, the KV namespace id, the GitHub OAuth client id, whether each secret has been set, the owner's numeric GitHub user id, the applied schema version, and the connector registration state.
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
- **Rate limiting on the unauthenticated surface.** The OAuth authorization, token, dynamic-registration, and `/health` routes are reachable by anyone who finds the URL. Unlimited, they burn Worker requests, D1 reads, and the deployer's own GitHub application quota. A Cloudflare rate-limiting rule on those routes is free and belongs in the deploy template rather than in a later hardening pass.
- **Logs never contain PRM content.** Structured logs carry tool name, duration, outcome, and a request id. They do not carry names, note text, or tokens. Workers observability is enabled in the Wrangler configuration so that a deployed instance is debuggable at all, and that only helps if the logs are safe to read.

## Failure modes

- **A write against the wrong person** is the failure that will actually happen. Mitigated by disambiguating context in search results, by writes taking a prefixed person id rather than a name, by prefix validation rejecting a roster entry id where a person id belongs, and by every write echoing the full affected record.
- **Bad merges** are avoided by having no merge tool in v1. `promote` either links to an existing person or creates a new one, and duplicates are tolerated. A tolerated duplicate is cheap; an unreversible bad merge is not. The gap this leaves is real and is named rather than hidden: two duplicate records that both have encounters attached cannot currently be reconciled, and that is the case a merge tool will eventually be designed against.
- **Import duplication** is prevented by a unique constraint on `(roster_source, external_row_key)`, so a re-run updates rather than duplicates.
- **D1 limits during import** are handled by making import resumable across tool calls rather than chunked within one, because the binding free-plan limit is 50 D1 queries per Worker invocation and chunking inside an invocation does not move it.
- **Duplicate writes from client retries** are prevented by the optional `idempotency_key` on every write.
- **Schema migrations** run through Wrangler's D1 migrations, applied with `--remote`, and user-deployed instances must apply them on deploy. `/health` reports the applied schema version so drift is detectable rather than mysterious.

### Backup and restore

An earlier draft said data loss "is covered by `wrangler d1 export` plus an `export_data` tool." Both halves were wrong.

`wrangler d1 export` does not support a database containing virtual tables, and FTS5 tables are virtual tables. The command that the spec named as the backup does not run against the schema the spec specifies.

`export_data` was also never in the tool list, so the surface was either larger than stated or the sentence was wrong. And returning the entire PRM through a tool result pushes the whole durable dataset into a conversation transcript, which is a strange thing to do deliberately. Anthropic's tool results are also capped at roughly 150,000 characters, so the export would truncate or fail exactly when there is enough data to be worth saving.

Backup is two layers, and neither of them is a single tool call:

- **D1 Time Travel** for short-term recovery: point-in-time restore, 7 days on the free plan and 30 days on paid, already on and needing no setup. This covers the overwhelmingly common case, which is a bad write ten minutes ago, and it covers it without anyone having remembered anything in advance.
- **A durable-data export run from the CLI to the operator's own machine,** not through Claude and not into another Cloudflare service. It selects the durable source tables explicitly, excludes the FTS5 virtual tables, and writes JSON to a local path the operator chooses. The FTS indexes are rebuilt from migrations on restore rather than being backed up, because they are derived data.

The restore is not a third layer, it is a property the second one has to have: **an export nobody has ever restored is not a backup.** Restoring into an empty database and comparing the result against the source is part of testing, not something documented and hoped for.

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

## Phasing

- **Phase 1** - Worker, D1, and the `OAUTH_KV` namespace; GitHub OAuth; the tool surface; migrations; the deploy template; and the agent-executable deploy runbook covering the web-first connector setup.
- **Phase 2** - a read-only self-contained HTML export of durable data, which doubles as the shareable demo artifact and needs no hosting.
- **Later, only if wanted** - a second identity provider, extracted against two real implementations rather than one; an optional local stdio adapter over the same tool module; and a merge tool designed against real duplicate data.

## Research findings, as of 2026-08-20

These were verified during design and should be re-checked if implementation starts much later.

- D1 supports the FTS5 module including `fts5vocab`: https://developers.cloudflare.com/d1/sql-api/sql-statements/
- Remote MCP connections originate from Anthropic's servers, not the user's machine; custom connectors are available on Free, Pro, Max, Team, and Enterprise, with Free limited to one: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Claude Mobile, iOS and Android, can use web connectors, and **installing** a connector from mobile is in beta, with Claude Desktop and the web named as the primary path for custom connectors. Checked 2026-08-21, which resolved what the first two drafts recorded as contradictory: https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities and https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Anthropic now documents fixed bearer tokens via connector request headers, in beta and rolling out gradually. Considered and set aside on 2026-08-20: a beta that a stranger may not have undercuts the shareability goal, so OAuth stays. Worth revisiting if it reaches general availability, because it would remove the entire authentication section.
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

- **Import protocol:** each call carries only its own chunk. The contract previously took the entire `rows` array on every call and sliced it server-side, which re-transmitted a 798-row roster six times through the model, in direct contradiction of this spec's own argument for parsing on the server. The first call now declares `expected_total`, later calls carry `run_id` and an in-order `offset`, and `finalize_import` accepts full coverage only when committed rows equal the declared total. The cost is stated where it lands: the server can no longer prove the chunk in front of it came from the roster the run was opened against. See `import_roster` is resumable across calls.
- **`people.notes` stays, with a job.** It holds standing facts that remain true between meetings; encounters hold what happened on a date. Left undifferentiated, the two were a drift waiting to happen. See Data model.
- **Backup is a local CLI export the operator runs,** not a Worker cron writing to R2. R2 leaves the copy in the same account it is meant to survive, and it adds a binding and probably billing details to a deploy aimed at a stranger. See Backup and restore, and Losing access, which now says what happens to an operator who never runs it.
- **Mobile connector installation is beta, not impossible.** Checked against Anthropic's documentation rather than left as an open question. See Onboarding sequence.

## Open questions

None. Every question the first three drafts left open has been answered above.

The next uncertainty is not a design question but an empirical one: nothing here has been run. The spec's claims about D1 limits, FTS5 behavior under D1, and the deploy sequence are researched rather than observed, and the first execution of plan 1 is what turns them into facts.
