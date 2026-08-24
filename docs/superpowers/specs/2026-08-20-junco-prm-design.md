# Junco PRM - Design

- Date: 2026-08-20
- Status: draft, under review. Nothing is implemented.
- Revised 2026-08-20, twice: first to record the three answers from Matt's review, then again after a four-agent independent review of the spec. The second pass reversed the two-provider decision, deleted the identity-echo mechanism, corrected several platform facts, and rewrote the data model, tool surface, and backup design. Decisions and their reversals are recorded in "Questions resolved on review" at the end.
- Revised a fifth time 2026-08-21, after a four-agent review of the fourth revision. It reversed two of that revision's changes: purge-then-import is not how a roster is refreshed (stale rows are annotated, never acted on), and `external_row_key` no longer doubles as the change-detection hash. See "Second review" at the end.
- Revised a fourth time 2026-08-21, after a three-agent review of this spec (a fourth timed out). Three structural changes came out of it: **roster retirement was removed entirely** because no caller-supplied completeness claim can safely gate a destructive operation, **`person_roster_entries` was dropped** because a durable table pointing at disposable rows was the defect this spec claims to have fixed, and **nine tools were added to the surface**, which previously had no way to record an email address. Details in "Questions resolved on 2026-08-21" at the end.
- Revised again 2026-08-21, after a four-agent review of the phase 1 implementation plan sent four questions back up to the spec. The import protocol now sends each row once instead of re-transmitting the roster on every call, `people.notes` has a stated job, the backup is a local export rather than an undecided one, and the mobile-connector question was checked rather than deferred. See "Questions resolved on 2026-08-21" at the end. There are now no open questions.
- Revised 2026-08-24, twice and both times small. First a duplicated `### Search` heading was repaired. Then two gaps surfaced by writing the phase 1 Worker plan were filled: the spec described the deployment's variables in prose but never named them, and the removal of the "identity echo" endpoint had left no statement of how an operator recovers from setting the owner id wrong. See "Configuration surface" under Deployment and "Losing access" under Operations. The `/health` contract under Verification was also pinned field by field, and its `owner_configured` renamed to `configured` and widened to cover every variable rather than the owner id alone. No design decision changed.
- Revised 2026-08-24 again, after the phase 1 measurement spike actually ran on a free Cloudflare account. **Two platform limits this spec asserted as fact are withdrawn:** a `db.batch()` does not spend one query per statement, and the free-plan CPU ceiling is not 10 ms - a 5,000-row invocation spent 163 ms and completed. The import chunk cap keeps its value of 150 and loses its justification, which is now a judgment about how many rows a model can emit in one tool call rather than a platform constraint. The `[[ratelimits]]` binding is available on the free plan, so the rate-limiting design ships rather than its fallback. There are now no open questions. See `docs/MEASUREMENTS.md`.
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
- `person_sources` - durable provenance, copied at promotion time rather than referenced: source key, external row key, `source_url`, `source_captured_at`, the roster's label and event as they read at promotion, and **both** a canonical-JSON snapshot of the raw record and its hash. Unique on `(source_key, external_row_key)`, because two people promoted from one roster row is a bug rather than a tolerated duplicate. The snapshot is **not returned by `get_person`**; see Security. An earlier draft said "a snapshot or hash" and left the choice open inside a document claiming no open questions. They do different jobs: the hash detects that the roster row changed since promotion, the snapshot is the only thing that can still show what was captured once the staged row is purged. A hash alone is worthless after the source disappears, which is exactly when provenance matters.

There is deliberately **no join table between a person and the roster rows they were promoted from.** An earlier draft had `person_roster_entries` and classified it durable while it pointed at staged rows, which is the same defect this section says was fixed, in a new shape: purging a roster either cascades into durable data or leaves rows in the backup pointing at data the backup does not contain. `person_sources` already stores `source_key` and `external_row_key`, and `roster_sources.source_key` is unique, so "has this roster row already been promoted?" is a join against durable provenance. That join survives a purge and a re-import a year later; a link to a staged row does not.

### Staged tables

- `roster_sources` - a logical roster that can be imported more than once: stable key, label, event, URL, and `purged_at`. **The row is permanent.** Purging deletes its entries and stamps `purged_at`; it never deletes the source itself. If source keys could be recycled, an agent that purges `wcus-attendees` and later imports the 2027 roster under the same obvious key would produce `(source_key, external_row_key)` collisions against 2026 provenance, and `promote_roster_entry` would return a 2026 person as its strongest evidence for a 2027 row. That is a silent write against the wrong person, which this spec names as its most likely real failure.
- `import_runs` - one attempt against a source: timestamp, format, status, the total the caller declared, how far it has got, and counts of inserted, updated, and skipped rows. There is no input hash: the server never sees the whole input under the chunked protocol below, so a hash of it cannot exist. Runs are bookkeeping and progress, not a lock.
- `roster_entries` - the imported row: its source, its `external_row_key`, a `content_hash`, the person fields as imported, the prototype's `source_url`, `source_captured_at`, and `raw_record` unchanged, plus `last_seen_run_id`. There is no `retired_at`; see Import identity.

### Why provenance is three tables and not one column

An earlier draft used a single `source_key` on `roster_entries` and a pair of pointers, `people.promoted_from_roster_entry_id` and `roster_entries.promoted_person_id`. Three separate defects, all cheap now and expensive after real data exists:

- **`source_key` had to mean two things at once.** If it identifies a roster, a re-import overwrites the record of the earlier capture. If it identifies a particular run, idempotency across runs fails. It cannot do both, so it is split into `roster_sources` and `import_runs`.
- **The pointer pair cannot represent one person on two rosters,** which is the normal case for anyone attending a conference twice. It also stores the same relationship in two places, so the two drift. `person_sources` replaces it: one row per person per source row, so a person can carry as many origins as they have.
- **Durable data pointed at disposable data.** The staged tables are explicitly described as re-fetchable and are not backed up, yet a person's only provenance lived there. Promotion now copies provenance into `person_sources`, so purging a roster never strips a person of their origin.

### Import identity

Idempotency is on the pair `(roster_source, external_row_key)`, with a unique constraint enforcing it, so a re-import updates rather than duplicates.

**The identity key and the change-detection hash are two different values.** An earlier draft used a hash of the whole normalized row as `external_row_key` when the source had no key of its own, and separately stored a hash on `person_sources` to detect that a roster row had changed since promotion. Those two jobs cannot share one value. If a job title is corrected between the August and September rosters, a whole-row hash produces a different key, so the corrected row is a *new* row, so the change is undetectable by construction, a duplicate lands beside the stale original, and `promote_roster_entry` finds no prior provenance and offers to create a second Jane. With no join table any more, `(source_key, external_row_key)` is the only link between a person and where they came from, so it has to survive exactly the re-import it exists for.

`external_row_key` is therefore, in order:

1. the source's own row identifier when it has one;
2. otherwise the row's normalized email address, which is the closest thing to an identity a person carries;
3. otherwise the SHA-256 of a **stable identity subset**: normalized full name and normalized organization, and nothing else.

`content_hash` is the SHA-256 of the whole normalized row and is recomputed on every import. It answers "has this row changed since we last saw it," including since a person was promoted from it.

It is never the person's name alone: the prototype roster contains 11 duplicated names covering 23 rows, so a name is not an identity. Note what case 3 concedes: two people with the same name at the same organization, on a source with no keys and no emails, are one row. That is rare, it is visible as a duplicate when it happens, and every alternative makes ordinary re-imports worse.

**Normalization is pinned here because it can never be changed.** Every `external_row_key` in every deployed instance is a function of these rules, and altering one later orphans all of them with no way to recompute, since the rosters they came from may no longer exist. Trim whitespace and collapse internal runs to a single space; apply Unicode NFKC; lowercase using a locale-independent fold; strip a leading or trailing comma-separated suffix from names only when it is a known honorific; for emails, lowercase the whole address and do not strip plus-addressing, because `ada+wcus@example.test` may be a different person's mailbox alias and the cost of merging two people is higher than the cost of two rows. Hashes are SHA-256 over UTF-8 canonical JSON with object keys sorted.

**Nothing is ever retired, and a re-import never removes anything.** An earlier draft marked rows a run had not seen as `retired_at` when the run claimed full coverage. That mechanism was removed on 2026-08-21 after three independent reviewers found the same hole: whether the run declared a row count or hashed its whole input, the completeness claim came from the same act of reading that could have truncated. An agent whose CSV was clipped, or whose page lazy-loaded 300 of 798 rows, declares the total it can see, satisfies every check, and destroys 498 current rows with nothing said out loud. A caller assertion cannot gate a destructive operation.

**A stale row is annotated, not acted on.** The observation retirement was making is worth keeping; only the verb was wrong. Every entry carries `last_seen_run_id`, and every source knows its latest **completed** run, so "this row was not in the most recent import" is a derived fact available at no schema cost:

- `search_people` roster hits carry `stale: true` when the row was not seen by the source's latest completed run, along with the date that run finished.
- `list_roster_sources` reports current and stale counts separately: "818 current, 40 not seen since the August run, 12 promoted."
- Nothing deletes, hides, or rewrites a stale row. It stays searchable and promotable, because a person who left the attendee list is still someone you met.

A second draft prescribed `purge_roster_source` followed by a fresh import as the way to refresh a roster. That was worse than what it replaced: purge destroys every row **before** the multi-call import that is supposed to replace them, so an import that dies on chunk three leaves the user with no roster at all, and the failure needs only a dropped connection rather than a truncated file. Re-import is additive and is the normal path. Purge survives for what it is actually for: "I am done with this roster."

### Search

Search uses FTS5 with bm25 ranking. Two indexes, not one, because people and encounters are different entities and conflating them produces results an agent cannot explain: one over `people` (names, organization, job title, notes) and one over `encounters` (summary). Tags participate in people search too, matched directly against the tag tables rather than through the index, because tag membership changes without `people` being written and no trigger on `people` would fire.

**Staged rows are deliberately not FTS-indexed.** `search_people` with `scope: roster` or `scope: all`, and the duplicate check inside `create_person`, run a bounded `LIKE` scan over `roster_entries` instead. At the scale this system is designed for, a few hundred to a few thousand staged rows, that is fast enough, and an FTS index over staged data would fire triggers on every imported row, spending exactly the CPU budget the import protocol is fighting for. This is a decision rather than an omission, and it is the first thing to revisit if roster search gets slow.

`person_contacts` carries an index on its normalized value, because `create_person`'s duplicate check matches on email and would otherwise scan. That index is also what makes "who is bob@example.com" answerable, which `search_people` supports as a query.

Roster hits carry `promoted_person_id`, non-null when durable provenance already exists for that `(source_key, external_row_key)`. Without it the two arrays that cannot be confused would still contain the same human twice, with nothing connecting them, and an agent would waste a promotion call to discover it.

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

1. `search_people` - FTS5 search over names, organization, title, tags, and note text. Takes an explicit `scope` of `people`, `roster`, or `all`, never a boolean flag. The value is `people` rather than `contacts` because `contacts` already means email addresses and phone numbers everywhere else in this surface. It returns **two named arrays, `people` and `roster_entries`,** rather than one list with a `record_kind` discriminator. This spec names "a write against the wrong person" as the failure most likely to actually happen, and an agent cannot confuse two kinds of record that never share an array. Each hit carries organization and last encounter inline so a second call is rarely needed, and roster hits never carry `raw_record`.
2. `get_person` - the record in one call: contacts, links, tags, open follow-ups, provenance, and recent encounters with a total count. Encounter history paginates rather than promising every encounter forever.
3. `list_encounters` - by person, event, or date range. Answers "who did I meet at WordCamp," which is a top-three conference question that `search_people` cannot answer.
4. `list_due` - open follow-ups, overdue first. The tool that answers "what am I forgetting."
5. `list_roster_sources` - what has been imported, when, how much of it has been promoted, and how old it is. Age is there so an agent can suggest purging a roster nobody has touched in months, which nothing else in the surface would ever raise.
6. `get_roster_entry` - one staged row by its `re_` id, with the imported fields, its provenance, whether it is stale, and whether it has already been promoted. It does not return `raw_record`. Without it an agent can find and promote a roster row but never read one, which is a strange hole in a surface this size.
7. `export_data` - durable records a page at a time, with an explicit scope and cursor. It answers "give me my data" inside a conversation. It is **not** the backup, for the reason under Backup and restore: tool results are capped by the client, the cap is not a documented contract, and an export worth having is an export that hits whatever it is.

### Writes

8. `create_person` - creates. Fails if it would need an id. It runs the same duplicate check `promote_roster_entry` does, against people **and** staged roster entries, and refuses on a strong match unless given `force: true`, returning the candidates instead. Without that check the most common sentence a user says at a conference, "add Jane, I just met her," silently creates a durable duplicate of a roster row that was sitting there waiting to be promoted, and loses her provenance permanently.
9. `update_person` - updates scalar fields by explicit person id. It does not touch contacts, links, or tags; those have their own tools below.
10. `archive_person` and `unarchive_person` - set and clear `archived_at`, which previously existed as a column no tool could set.
11. `delete_person` - permanent, two calls, preview then confirm. It exists because a PRM holding other people's contact details cannot answer a deletion request with "we only archive." An earlier draft argued for it in prose and then left it out of this list.
12. `add_contact` and `remove_contact` - an email address or phone number.
13. `add_link` and `remove_link` - a website or social profile.
14. `add_tags` and `remove_tags` - add or remove tags without touching the rest of the set. An earlier draft had a single `set_tags` that replaced the whole set, which is exactly the replace-semantics shape the paragraph below argues against, sitting among three add/remove pairs. Tags are also the attribute most often edited incrementally, so it was the worst place for it.
15. `log_encounter` - person, when, where, what happened, optional follow-up. The highest-frequency write.
16. `update_encounter` and `delete_encounter` - correct or remove a mis-logged encounter. Delete here is a hard delete in one call, deliberately outside the two-call rule below, because the point is to erase a mistake someone just dictated from a phone.
17. `create_followup`, `complete_followup`, `cancel_followup` - what is owed to someone, closing it out, and dropping it. It is `create_`, not `set_`, because a person may owe several things at once and `set_` reads like an upsert that would silently replace one.
18. `import_roster` - one chunk of a roster. See below.
19. `finalize_import` - marks a run complete. It destroys nothing, and it is not ceremony: "the source's latest **completed** run" is what every staleness annotation is measured against, so a run nobody finalizes simply never becomes the baseline. An abandoned run is inert rather than harmful.
20. `promote_roster_entry` - two calls, not one. See below. The name says what it operates on, matching the `re_` prefix of its only required argument.
21. `purge_roster_source` - deletes a source's staged entries, two calls, preview then confirm. The `roster_sources` row itself survives as a tombstone with `purged_at` set, so its key can never be recycled onto different data. Promoted people and their copied provenance are untouched.

That is 28 named tools, since five of the numbered items above are two or three tools each. The count is stated because an earlier draft numbered its list to 14, was actually 19, and omitted tools its own prose required. A spec that argues about surface size should be able to count its own surface.

Attributes get their own tools rather than arrays on `update_person`. The alternative was considered and rejected: with replace-arrays, omitting a field has to mean "leave alone" while passing an empty array means "delete every contact this person has," and that is a destructive distinction an agent gets wrong silently. Separate tools remove the ambiguity instead of documenting it.

`create_person` and `update_person` replace a single `upsert_person`. Requiring an explicit id for updates was right and is kept; the name was the problem. "Upsert" invites an agent to assume the server will match on name, and this server never matches on name to select a record. Name similarity appears in exactly one place, as **evidence returned to the caller** by `promote_roster_entry` and `create_person`, and it never picks a person on its own.

### Id discipline

Every id is prefixed by kind and every tool validates the prefix: `p_` for a person, `re_` for a roster entry, `enc_` for an encounter, `fu_` for a follow-up, `rs_` for a roster source.

This is not cosmetic. `search_people` can return two entity kinds, and the failure the spec names as most likely, a write against the wrong person, arrives most easily by an agent passing a roster entry id into `log_encounter`. A prefixed id makes that a validation error instead of a corrupted record.

### `promote_roster_entry` is two-phase

Surfacing duplicate candidates and committing a promotion cannot happen in one call, because the agent has to see the candidates before choosing.

- `promote(roster_entry_id)` writes nothing and returns duplicate candidates with the evidence for each. Evidence includes a shared email, a shared name, a shared organization, and, strongest of all, an existing `person_sources` row carrying this roster's `source_key` and this row's `external_row_key`, which means this exact row was promoted before, possibly under an earlier import of the same roster.
- `promote(roster_entry_id, link_to_person_id | create_new: true)` commits, and copies provenance into `person_sources`.
- Promotion is idempotent, and the check runs **before** the caller's intent is honored. An exact provenance match on `(source_key, external_row_key)` returns the existing person and creates nothing, even when the call said `create_new: true`. Tolerating duplicates the system cannot detect is a considered position; creating one the system is already holding provenance for is a bug, and an agent that skipped straight to phase two should not be able to cause it.
- Beyond that override, the two-phase shape is advisory: nothing forces an agent to look at candidates first, unlike `delete_person` and `purge_roster_source`, which require a token from their preview call. That asymmetry is deliberate. Promotion's worst outcome is a duplicate person, which is recoverable and which the provenance override already prevents in the case the system can see; a confirmation token on the highest-frequency conference action would cost a round trip every time.
- The commit call verifies the row's `content_hash` matches what the preview saw. If the roster row changed or was purged between the two calls, the commit is refused rather than promoting a person from data the caller never inspected.

### `import_roster` is resumable across calls

An earlier draft passed a whole CSV through one tool call and described "chunked writes with progress reported back." That does not work, for two separate reasons.

The first is a platform limit. D1 allows 100 bound parameters per query, which is real and still binds: `roster_entries` has 16 columns, so a multi-row upsert carries 6 rows. **Two other limits this spec previously cited here turned out not to exist as documented, and were removed on 2026-08-24 after being measured.** See "Where the chunk cap comes from" below.

The second is that an MCP tool call is one-shot. There is no channel for a server to report progress during a call, so "progress reported back" was not implementable as written.

Import is therefore a protocol, and the tool contract says so:

- `import_roster(source_key, label, source_url, format, rows, expected_total?, run_id?, offset?)` returns `{run_id, imported, updated, skipped, errors, next_offset, remaining}`. The agent loops until `remaining` is zero, then calls `finalize_import(run_id)`.
- **The first call declares `expected_total`**, which is required rather than optional despite reading as optional in the signature above, and carries the first chunk. The server opens a run recording that total, and every later call carries `run_id`, the `offset` it is continuing from, and only its own chunk. `expected_total` drives progress reporting and nothing else; it gates no destructive action, because there is no longer a destructive action for it to gate.
- **`offset` must equal the run's `next_offset` exactly.** A call that skips ahead or replays committed ground is refused, so the agent's loop stays honest and `remaining` means what it says. A mismatch is a recoverable error: the response carries the run's true `next_offset` and `remaining`, so the agent's next call is obviously correct rather than a guess.
- **A chunk is idempotent on `(run_id, offset)`.** A retry after a dropped response replays the original result instead of being rejected, which is what makes the single most likely runtime failure in the system self-healing. An explicit `idempotency_key` is accepted but not required for this.
- Each call is capped at a server constant well under the free-plan limits, on the order of 150 rows. A chunk larger than the cap is **rejected, not truncated**: the agent decides the chunking, so silently dropping the tail would lose rows without anything saying so.
- **The agent sends parsed row objects, not raw CSV text.** A chunked protocol cannot hand the server arbitrary slices of a CSV file, because a row boundary is not findable without parsing and a quoted newline puts the boundary inside a field. `parseCsv` exists for the agent to call on whole small files and for tests; the wire format for a chunk is always normalized row objects. Where a CSV is parsed, the dialect is stated: comma-delimited, double-quote quoting with doubling for escapes, `\r\n` or `\n` line endings, UTF-8 with an optional BOM stripped, and the first non-empty line as the header.
- The agent sends each row exactly once across the whole run. An earlier version of this contract took the entire `rows` array on every call and sliced it server-side, which meant a 798-row roster crossed the model six times. That was decided against on 2026-08-21.
- Validation happens in application code before any query, so per-row errors are reported without costing a query each. Writes are batched multi-row upserts, which report aggregate inserted and updated counts. A row the server refuses consumes its offset and is reported with its index and reason; the agent fixes those rows and sends them as an ordinary later import rather than as a continuation.
- Committed chunks are live immediately. A half-imported roster is a usable roster: its rows are searchable under `scope: roster` and promotable. That is deliberate, because the moment this feature exists for is standing at a conference with a partially-loaded attendee list.

**Where the chunk cap comes from: measurement, and the measurement has now been taken.** Run on 2026-08-24 against a free Cloudflare account. Full numbers in `docs/MEASUREMENTS.md`; the conclusion is that **neither platform limit this spec worried about actually binds.**

Two earlier drafts derived the cap from D1's query budget, on the reading that each statement inside a `db.batch()` spends one of the 50 queries a free-plan invocation is allowed. That derivation was withdrawn as probably wrong, and the measurement confirms it: **a `db.batch()` of 500 statements completes on a free plan in 3 ms of CPU.** `batch()` does not spend a query per statement, and the query budget does not bound a chunk.

The constraint this spec then nominated as the one that probably does bind was **10 ms of CPU per invocation**, on the reasoning that a chunk normalizes every row, builds canonical JSON, and computes two SHA-256 digests per row. That figure is **stale and is withdrawn too**: a 5,000-row invocation doing exactly that work spent **163 ms of CPU and completed**, on a free account, with no ceiling found. A row costs about 0.033 ms, so a 150-row chunk costs roughly 5 ms - comfortably inside even the limit that turned out not to apply.

**What bounds the chunk is therefore the model, not the runtime.** A chunk is roster rows a language model has to emit as JSON in one tool call, at roughly 50 to 100 tokens per row. 150 rows is 7,500 to 15,000 tokens of tool input, which is a reasonable amount to ask for in one call and to re-emit on a retry; 500 rows would be 25,000 to 50,000, which is not. The cap keeps its value of 150 and loses its original justification entirely, and anyone raising it later should be arguing about tool call size rather than about Cloudflare.

The cap was therefore an empirical constant, measured by the first implementation task before any import code existed. **That task has run**, on 2026-08-24. All three questions came back, and two came back differently from what this spec expected:

- a `db.batch()` of 49, 50, 60, 200 and 500 trivial statements on a free-plan Worker - **every size succeeded**, so `batch()` does not spend a query per statement;
- CPU per row for normalization, canonical JSON, and two digests - **0.033 ms**, against a free-plan ceiling that proved to be at least 163 ms rather than the 10 ms stated above;
- and, in the same deploy, whether a `[[ratelimits]]` binding is accepted on a free account at all - **it is**, so the rate-limiting design ships rather than its KV fallback.

`IMPORT_BATCH_LIMIT` stays at 150, for the tool-call-size reason given above rather than for any platform reason. `docs/MEASUREMENTS.md` records the numbers, the account plan they were taken on, and what was not established.

**What the server can and cannot verify about a resumed run.** It checks that the run exists and is open, that it belongs to the source and format being imported, and that the offset is the one expected. It cannot verify that the chunk in front of it comes from the same roster the run was opened against, because it no longer sees the whole input. **Nothing rests on that verification any more.** Under the previous design the declared count gated retirement, and three reviewers independently showed that a caller-supplied count cannot gate a destructive operation; retirement is gone and the question went with it. The worst a wrong `expected_total` can now do is make `remaining` misleading.

### Rules that make this LLM-first

- Returns are rich, so one call usually suffices.
- Every write returns the full affected record, so mistakes are visible in the transcript immediately.
- Every write takes an optional `idempotency_key`. Mobile connections drop, clients retry, and a retried `log_encounter` must not produce a second encounter.
- Destructive operations against a person or a whole roster use an explicit two-call protocol: the first call returns a preview and a confirmation token, the second call presents that token. `delete_person` and `purge_roster_source` are the two. `delete_encounter` is a deliberate exception and deletes in one call, because it exists to erase a mistake someone just made. An earlier draft said destructive things "propose and wait for confirmation," which a one-shot tool call cannot do. The client's own approval UI is a second layer, not a substitute.
- **Every read tool has a default and a maximum page size, and one pagination convention:** an opaque cursor plus `limit`, the same everywhere, and `search_people` returns a cursor per array since it returns two. Clients cap tool results, the cap is not a documented contract, and `search_people` over a large roster or an unbounded `list_encounters` reaches whatever it is as easily as an export does. Page sizes are therefore set conservatively rather than derived from a number nobody can cite.
- **Every tool result carries the current date in the owner's time zone.** The agent does not otherwise know it, and "follow up tomorrow" dictated at 11pm Pacific is wrong for a third of every day if the model assumes UTC or guesses. This is one field on every response and it removes an entire class of off-by-one errors from the highest-frequency writes.
- **Every tool declares MCP's static annotations** - `readOnlyHint`, `destructiveHint`, `idempotentHint` - because clients use them to decide what to approve and what to run without asking, and a surface this size should not make a client guess.
- **Errors are part of the tool surface, not plumbing.** Every rejection returns a machine-readable code, a human-readable reason, and, where one exists, the corrective next call. An `re_` id passed to `log_encounter` says "promote this roster entry first" rather than only "invalid id," because the caller is a model that will otherwise guess. The codes are a closed set fixed here, because clients and tests both bind to them: `invalid_input`, `invalid_id`, `not_found`, `conflict`, `confirmation_required`, `confirmation_invalid`, and `limit_exceeded`.

### Where operational state lives

Three behaviors above are asserted as guarantees and need somewhere to live, or they are unimplementable prose. All three go in D1, not KV: the retry that matters arrives a second later, and KV's eventual consistency makes it exactly wrong for deduplication.

- **Idempotency keys.** A table keyed by `(tool, key)` holding the request hash, the stored response, and a timestamp. A replay with a matching hash returns the stored response; a replay with a different hash is a `conflict`. Rows older than a retention window are prunable.
- **Confirmation tokens.** A table holding the token, the action, the target id, the preview, an expiry, and a redeemed-at. Redemption is a single conditional update, so two calls cannot both spend one token.
- **Import chunk receipts.** `(run_id, offset)` with the row count, the payload hash, and the stored result, so a retried chunk replays its original result instead of being rejected for presenting an offset the run has already passed. Without this the retry-after-dropped-response case wedges a run at an offset the caller cannot discover.

The retry lookup happens **before** the offset check, or the mechanism that exists to make retries safe is unreachable behind the rule it exists to soften.

## Authentication

OAuth 2.1 is required here, and that is this project's decision rather than a platform rule. Anthropic's connector documentation now supports unauthenticated connectors and a beta static-header option alongside OAuth. An earlier draft cited the platform as forbidding authless connectors for private data; what is actually true is that nothing stops you, and a PRM full of other people's contact details on a public URL is indefensible regardless of what the platform permits.

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

Two consequences worth writing down rather than discovering. `workers-oauth-provider` exposes grant listing and revocation, so revoking one grant does not require clearing the whole KV namespace; clearing it is the blunt instrument, and it also removes the registered Claude client, so the owner has to add the connector again. And KV is eventually consistent, so a deletion can take a minute or more to propagate; comparing the stored id against the current allowlist variable on every request is what makes revocation-by-allowlist-change immediate, rather than the KV delete.

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

### Configuration surface

Every variable and binding a deployment carries, named literally, because the runbook, the Worker, and the upgrade document all have to agree about them and prose descriptions do not survive that.

**Secrets**, set with `wrangler secret put` and never written into the Wrangler configuration file:

- `GITHUB_CLIENT_SECRET` - from the GitHub OAuth application.
- `COOKIE_ENCRYPTION_KEY` - random 32 bytes, hex. `workers-oauth-provider` encrypts its consent cookie with it.

**Plain variables**, set in the Wrangler configuration file, visible in the dashboard:

- `GITHUB_CLIENT_ID` - from the GitHub OAuth application. Public by design; it appears in the authorization URL.
- `OWNER_GITHUB_USER_ID` - the owner's **numeric** GitHub user id, as a string.
- `OWNER_TIMEZONE` - an IANA zone.

**Bindings:**

- `DB` - the D1 database.
- `OAUTH_KV` - the Workers KV namespace `workers-oauth-provider` requires.
- `RATE_LIMITER` - the Workers rate-limiting binding, only if it proves available on the free plan. See Security and data handling.

**`OWNER_GITHUB_USER_ID` is a plain variable rather than a secret, deliberately.** It is not a credential: it is a public number anyone can resolve from a username, and the OAuth flow rather than its secrecy is what protects the instance. Making it a secret would hide it from deploy output and from the dashboard, which is exactly where an operator needs to see it when working out why their own requests are being refused.

**The Worker fails closed if any of the five is missing or invalid**, and validates rather than merely checking presence. `OWNER_GITHUB_USER_ID` must be digits, because the likeliest operator error is pasting a username, and `OWNER_TIMEZONE` must be a zone `Intl` recognizes, because a typo'd zone otherwise surfaces much later as a crash inside `list_due` rather than as a refused deploy.

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

The agent asserts that the Worker responds, that it refuses tools when unauthenticated, and that migrations are applied. This needs an endpoint that the spec has to define rather than assume: `/health`, unauthenticated, returning exactly four fields and nothing else.

- `status` - `"ok"` if the Worker is running. It has no other value; a Worker that cannot answer does not answer.
- `schema_version` - the name of the last applied migration, read from D1's own `d1_migrations` table rather than from a constant in the code. That is the point of it: it reports what the **database** believes, so it can disagree with the deployed code, which is exactly the drift the field exists to surface. It is `null` on a database that has never been migrated, which is a real state during a first deploy and one this route has to survive rather than crash on.
- `configured` - whether every variable and binding under "Configuration surface" is present and valid. An earlier draft called this `owner_configured` and scoped it to the owner id alone; it covers all of them, because an instance missing its cookie key is just as unusable as one missing its owner, and an operator debugging a deploy should not have to guess which of five things this field is talking about.
- `request_id` - so a report can be matched to a log line. `/health` is the one route an operator can reach before anything else works, and it is where a support conversation starts.

**`/health` answers even when configuration is incomplete, and it is the only route that does.** Everything else fails closed. An operator debugging an unconfigured instance needs something to respond, and this route holds no data - it reports `configured: false` and carries on.

Three things it deliberately does **not** report: the owner id, the client id, and any row count. The first two are the configuration an attacker would want; the third is a small leak with no upside, since "42 people" tells a stranger the instance is in use and worth a second look. It also does not report whether the instance is unclaimed in a way that invites claiming, since with the owner id set as configuration before first deploy there is no unclaimed window to advertise.

That is not sufficient on its own. Reachability and a refused anonymous request say nothing about whether the owner can actually sign in, whether the GitHub application is configured correctly, or whether Claude can complete a connection. The runbook therefore ends with an **authenticated** end-to-end check: connect the connector, call one harmless read tool, and confirm a real result comes back. Fail-closed is confirmed rather than assumed, and so is fail-open.

### Relationship to the deploy button

A one-click "Deploy to Cloudflare" template can now provision and bind both D1 and KV and run migration scripts, which covers more of the runbook than an earlier draft assumed. It still cannot register a GitHub OAuth application and cannot set the owner allowlist. It is therefore a shortcut used from inside the runbook rather than an alternative to it, and the runbook stays the supported path.

## Security and data handling

- TLS in transit, Cloudflare's encryption at rest, and account isolation.
- No application-layer encryption of note text. Encrypted text cannot be searched with FTS5, and the threat model is the user's own Cloudflare account rather than a shared host. This is a deliberate trade, not an oversight.
- No compression. A PRM database is single-digit megabytes.
- **Imported roster text is untrusted input.** It is written by strangers, it is fetched from the public web, and it is read back to an agent that can call write tools. A roster row whose job title reads like an instruction is the obvious prompt-injection vector, and it costs nothing to design against now. Tool results mark imported and stored free text as data rather than presenting it as narration, and the tools that act destructively require an explicit id plus a confirmation token, so injected text cannot cause a write on its own.
- **Rate limiting on the unauthenticated surface.** The OAuth authorization, token, dynamic-registration, and `/health` routes are reachable by anyone who finds the URL. Unlimited, they burn Worker requests, D1 reads, and the deployer's own GitHub application quota. An earlier draft called for "a Cloudflare rate-limiting rule," which cannot be written at all here: WAF rate-limiting rules are authored per zone, and a `workers.dev` deployment has no zone in the deployer's account. What the template can actually ship is the **Workers rate-limiting binding**, declared in `wrangler.jsonc` and enforced in code, with its `period` set to 10 or 60 seconds, which are the only values it accepts. It has to **wrap the OAuth provider's fetch handler**, not sit inside a tool handler: `workers-oauth-provider` serves `/authorize`, `/token`, and `/register` itself, so a limiter behind it never sees the routes this bullet exists to protect. One reviewer believes the binding requires a paid plan and would fail deployment on a free account; the binding's documentation says nothing either way, so the first stub deploy on a free account settles it, and the fallback if it is refused is a token bucket over the KV namespace the deployment already has. Two honest caveats: Cloudflare describes it as permissive and eventually consistent rather than exact, so it is protection against burning quota and not an accounting mechanism; and it runs inside the invocation, so it cannot protect the 100,000-requests-per-day Worker quota itself, only the D1 and GitHub work behind it.
- **Dynamic Client Registration is an unauthenticated write.** Anyone who finds the URL can register clients in a loop. Rate limiting bounds the volume and constraining accepted redirect URIs to Anthropic's documented callback bounds the usefulness, but neither closes it: a registration still costs a KV write, and the limiter is per-location and permissive. Registered clients also expire on a default lifetime, which a long-lived personal instance has to choose deliberately rather than inherit.
- **Imported roster text is not returned by any routine read.** `raw_record` is stored on the staged row, and a canonical snapshot of it is copied into `person_sources` at promotion so provenance survives a purge. Neither is returned by `search_people`, `get_roster_entry`, or `get_person`. An earlier revision added the snapshot and left `get_person` returning "provenance," which put attacker-controlled text into the context window immediately before every write against that person - a bigger hole than the search one the same revision closed. `get_person` returns provenance **metadata**: source key, label, event, URL, captured-at, the hash, and whether the current staged row still matches it. The snapshot itself is reachable only through the CLI export.
- Marking hostile text as data is a convention, not a boundary. The claim that injected text "cannot cause a write" is too strong and is withdrawn: structured untrusted text can still steer a model into calling a non-destructive write tool. What the design actually provides is that destructive operations need an explicit id plus a token minted by a preview the human can read, and that the highest-volume untrusted text never reaches the model at all.
- **Authentication failures are logged** with the presented numeric id. The logging rule below forbids PRM content, not security events, and a rejected identity is the only signal that someone is probing the instance.
- **Foreign keys are on, and cascades do not fire triggers.** D1 enforces foreign keys, and this design depends on cascades for `delete_person` and `purge_roster_source`. SQLite is explicit that foreign key actions are unaffected by the recursive-triggers setting, which means rows deleted by a cascade may not fire the `AFTER DELETE` triggers that maintain the FTS indexes. Left alone, that puts a hard-deleted person's encounter text in the search index forever, which is the worst possible place for it given that `delete_person` exists to satisfy erasure requests. So `delete_person` deletes children explicitly, in application code, inside the same batch, and a test asserts that no FTS row survives a hard delete.
- **Logs never contain PRM content.** Structured logs carry tool name, duration, outcome, and a request id. They do not carry names, note text, or tokens. Workers observability is enabled in the Wrangler configuration so that a deployed instance is debuggable at all, and that only helps if the logs are safe to read.

## Failure modes

- **A write against the wrong person** is the failure that will actually happen. Mitigated by disambiguating context in search results, by `search_people` returning people and roster entries in separate arrays so the two cannot be confused, by writes taking a prefixed person id rather than a name, by prefix validation rejecting a roster entry id where a person id belongs, and by every write echoing the full affected record. Echoing the record detects the mistake; it does not prevent it, which is why the id discipline above carries the weight.
- **Bad merges** are avoided by having no merge tool in v1. `promote_roster_entry` either links to an existing person or creates a new one, and duplicates are tolerated. A tolerated duplicate is cheap; an unreversible bad merge is not. The gap this leaves is real and is named rather than hidden: two duplicate records that both have encounters attached cannot currently be reconciled, and that is the case a merge tool will eventually be designed against.
- **Import duplication** is prevented by a unique constraint on `(roster_source, external_row_key)`, so a re-run updates rather than duplicates.
- **D1 limits during import** are handled by making import resumable across tool calls rather than chunked within one. The original reason - a 50-query-per-invocation cap - was measured on 2026-08-24 and does not hold: a 500-statement `db.batch()` succeeds on a free plan. Resumability is kept anyway, and now for a better reason: an MCP tool call is one-shot, a roster does not fit in one call's worth of model output, and a multi-call import that cannot resume is one dropped connection away from starting over.
- **Duplicate writes from client retries** are prevented by the optional `idempotency_key` on every write, and by import chunks being idempotent on `(run_id, offset)` whether or not a key was supplied.
- **A caller asserting completeness** is no longer a failure mode, because nothing acts on such an assertion. Retirement was the only place a claim about the outside world could destroy data, and it was removed on 2026-08-21.
- **Schema migrations** run through Wrangler's D1 migrations, applied with `--remote`, and user-deployed instances must apply them on deploy. `/health` reports the applied schema version so drift is detectable rather than mysterious.

### Backup and restore

An earlier draft said data loss "is covered by `wrangler d1 export` plus an `export_data` tool." Both halves were wrong.

`wrangler d1 export` does not support a database containing virtual tables, and FTS5 tables are virtual tables. The command that the spec named as the backup does not run against the schema the spec specifies.

`export_data` was also never in the tool list, so the surface was either larger than stated or the sentence was wrong. And returning the entire PRM through a tool result pushes the whole durable dataset into a conversation transcript, which is a strange thing to do deliberately. Tool results are capped by the client, at a size no Anthropic documentation states as a contract, so the export would truncate or fail exactly when there is enough data to be worth saving.

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

Workers run in UTC. `create_followup` and `list_due` deal in dates, and "follow up tomorrow," typed from a phone in Pacific time, is wrong for roughly a third of every day if the server assumes its own clock.

The deployment carries an `OWNER_TIMEZONE` variable set at deploy time. Timestamps are stored as UTC instants; due dates are stored as local date strings and interpreted in the owner's zone. This is small to get right now and unpleasant to retrofit once there is data.

### Upgrading an existing instance

A user who deployed in March and hears about a fix in June has no mechanism to get it. `docs/UPGRADE.md` covers it: pull, install with a lockfile, apply migrations with `--remote`, deploy, and confirm the schema version through `/health`. Migrations are backward-compatible within a major version, and a pre-migration Time Travel bookmark is recorded before any migration runs.

### Cost

The first question a stranger asks is whether this will cost them money, and an unanswered version of that question is a reason not to deploy. The deploy documentation answers it with numbers: the free plan is sufficient for this workload, and the limits that bind are **500 MB per database, 10 databases per account, 100 bound parameters per query, and 100,000 Worker requests per day.** Two limits this spec previously listed here - 50 D1 queries per Worker invocation and 10 ms of CPU per invocation - were measured on 2026-08-24 and do not bind: a 500-statement batch and a 163 ms invocation both completed on a free account. See `docs/MEASUREMENTS.md`.

### Losing access

Four ways to lose access, with four different answers, stated plainly because the honest answer to one of them is bad:

- **Losing the GitHub account** is recoverable. Resolve the new numeric user id, update the allowlist variable, redeploy. Existing grants are invalidated by the allowlist change.
- **Setting `OWNER_GITHUB_USER_ID` to the wrong number** is recoverable, and the instance tells the operator what the right one is. This is the case an earlier draft's "identity echo" endpoint existed to solve, and removing that endpoint left no statement of what replaced it, so it is written down here.

  A wrong-but-numeric id passes validation, so the deploy succeeds and `/health` reports the instance as configured. The symptom is that the owner completes the GitHub consent screen and every subsequent tool call is refused. The diagnosis is one command: `wrangler tail` shows an `auth_failure` line carrying the numeric id that **was** presented, which is the owner's real id and therefore exactly the value the variable should have been set to. Copy it, set it, redeploy. The connector does not need to be removed and re-added.

  This works because authentication failures are logged with the presented identity, which is the one deliberate exception to the rule that logs never carry identity. It was written for detecting someone probing the instance; that it also hands the operator their own id when they have mistyped it is a second use for the same line, and worth keeping in mind before anyone narrows what that log records.
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
- A measurement, not a test, run before the import code exists, and it answers three things in one stub deploy on a free account: whether a `db.batch()` of 49, 50, and 60 statements survives; how many CPU milliseconds a row costs to parse, canonicalize, and hash twice; and whether a `[[ratelimits]]` binding is accepted on a free plan at all. The chunk cap comes out of the second, the first settles a documented contradiction, and the third decides whether the rate-limiting design or its KV fallback ships.
- A hard-delete test that asserts **no FTS row survives**, because cascaded deletes may not fire the triggers that maintain the search index and the symptom is a deleted person still appearing in search.
- Promotion idempotency. Promoting the same roster row twice returns the same person and creates nothing, including after that roster has been purged and imported again, and including when the second call says `create_new: true`.
- A row-identity test: a roster imported twice with one row's job title corrected produces one row with a changed `content_hash`, not two rows. This is the case that broke under the previous key design and it is invisible to any test that imports a roster only once.
- A staleness test: a row present in August and absent from September is marked stale, is still searchable, is still promotable, and is not deleted.

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
- Relevant D1 free-plan limits as **documented**: 500 MB per database, 2 MB per row, 100 bound parameters per query, 100 KB per SQL statement, 30 seconds per query or batch, and 50 D1 queries per Worker invocation; Workers documentation also states 10 ms CPU per invocation on the free plan: https://developers.cloudflare.com/d1/platform/limits/ - **the last two were measured on 2026-08-24 and did not hold in practice.** A 500-statement `db.batch()` and a 163 ms invocation both completed on a free account. Treat the published per-invocation numbers as a floor to design against rather than as observed behavior, and see `docs/MEASUREMENTS.md`.
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

## Decisions taken on the spec reviews, 2026-08-21

Two reviews of this file ran that day. The first, three agents of four, produced the changes recorded below under "First review." The second, four of four, reviewed those changes and found that two of them had gone wrong, which is recorded under "Second review." Both rounds are kept because the second one reversing part of the first is the most useful thing in this document's history.

### First review

- **Roster retirement is removed.** `finalize_import(full_coverage: true)` marked rows the run had not seen as retired, gated on the caller's declared row count. All three reviewers showed the same hole: an agent whose input was truncated declares the total it can see, satisfies every check, and destroys hundreds of current rows silently. The earlier hash-based version had the identical hole, because a hash proves the caller consistent with what it sent, never that what it sent was complete.
- **`person_roster_entries` is dropped.** It was classified durable while pointing at staged rows, so purging a roster either cascaded into durable data or left the backup carrying references to data it does not contain. The promotion link is derived from `person_sources`.
- **Nine tools were added** to a surface that had no way to record an email address, no `delete_person` despite this spec arguing at length that one must exist, and no `finalize_import` or `export_data` despite both appearing in its own prose.
- **`search_people` returns two named arrays** rather than one list with a discriminator.
- **`create_person` checks for duplicates** against people and roster entries and refuses on a strong match without `force`.
- **Authentication gained three specifics** a template gets wrong: the per-request check reads a stored numeric id rather than calling GitHub, the GitHub token is discarded once the id is known, and no scopes are requested.
- **The rate-limiting plan was corrected** from a WAF rule, impossible without a zone, to the Workers binding.
- **The deploy count went from three human blocks to four.**

### Second review

- **Purge-then-import is not how a roster is refreshed.** Three of four reviewers rejected it: it replaced a destructive operation gated by an unreliable claim with a destructive operation gated by nothing, sequenced before a multi-call import that can fail, so a dropped connection can leave the user with no roster at all. Re-import is additive, and a row the latest completed run did not see is **annotated stale rather than acted on**. The observation retirement was making was worth keeping; only the verb was wrong. See Import identity.
- **`external_row_key` no longer doubles as the change-detection hash.** A whole-row hash as identity means an edited row is a new row, so the edit is undetectable, a duplicate lands beside the stale original, and promotion cannot recognize it - and with the join table gone, that pair is the only link between a person and their origin. Identity now comes from the source's key, else a normalized email, else a hash of a stable identity subset; `content_hash` detects change. Normalization rules are pinned because they can never be changed afterwards. See Import identity.
- **`roster_sources` rows are permanent.** Purge deletes entries and stamps `purged_at`. If keys could be recycled, provenance from an old roster would collide with a new one under the same key and `promote_roster_entry` would return the wrong person as its strongest evidence.
- **`get_person` returns provenance metadata, not the raw snapshot.** The first review's change added a canonical snapshot to `person_sources`; `get_person` returning "provenance" then fed stranger-written text into the context window immediately before every write against that person, which is a worse version of the boundary the same revision claimed to close.
- **The chunk cap is measured, not derived.** Two reviewers showed the query-budget arithmetic rests on a number Cloudflare's own pages contradict, and that the binding constraint is more likely the 10 ms CPU limit, which this spec had mentioned once and derived nothing from.
- **`set_tags` became `add_tags` and `remove_tags`.** All four reviewers flagged it: one replace-semantics tool hiding among three add/remove pairs, on the attribute most often edited incrementally.
- **Operational state got a home.** Idempotency keys, confirmation tokens, and import chunk receipts were asserted as guarantees with no table behind any of them.
- **Smaller corrections:** cascaded deletes may not fire the FTS triggers, so `delete_person` deletes children explicitly; the rate limiter must wrap the OAuth provider rather than sit behind it; grants can be revoked individually rather than by clearing KV; roster hits carry `promoted_person_id`; staged rows are searched by bounded scan rather than FTS, stated as a decision; `promote` became `promote_roster_entry`, `set_followup` became `create_followup`, and the search scope `contacts` became `people`; error codes are a closed set; MCP tool annotations are declared; the unverified 150,000-character result cap is withdrawn as a number while its conclusion stands; and the claim that Anthropic forbids authless connectors for private data is corrected, since it does not.

## Open questions

None. The three that stood here until 2026-08-24 were unverified rather than undecided, and one stub deploy on a free Cloudflare account settled all three. Full numbers in `docs/MEASUREMENTS.md`; the answers are recorded here because two of them contradict what this document previously asserted as platform fact.

1. **Does a `db.batch()` of N statements spend N of the free plan's per-invocation query budget, or one?** **Not N.** Batches of 49, 50, 60, 200 and 500 statements all completed on a free plan, the largest in 3 ms of CPU. The query budget does not bound an import chunk, and the arithmetic two drafts of this spec derived the chunk cap from was wrong.
2. **How much CPU does a roster row cost** to parse, canonicalize, and hash twice? **About 0.033 ms** - and the 10 ms budget it was to be measured against does not exist as documented. A 5,000-row invocation spent **163 ms of CPU and completed** on a free account, with no ceiling found. The chunk cap is now bounded by how many rows a model can reasonably emit in one tool call, not by the runtime.
3. **Is the Workers rate-limiting binding available on the free plan?** **Yes.** It deployed, bound, and limited. The rate-limiting design ships; the KV token-bucket fallback is not needed.

**The condition that replaced them is narrower but has not gone away: almost nothing here has been run.** The measurement above covers three platform behaviors and nothing else. The claims about FTS5 under D1, about cascaded deletes not firing triggers, about `wrangler d1 export` refusing virtual tables, and about the deploy sequence are still researched rather than observed, and executing plan 1 is what turns them into facts.

It is worth noticing what the measurement actually demonstrated, beyond three numbers: **two of the platform limits this spec stated most confidently were wrong, and both were wrong in the direction of being more restrictive than reality.** Every remaining unobserved claim in this document deserves the same suspicion until someone runs it.
