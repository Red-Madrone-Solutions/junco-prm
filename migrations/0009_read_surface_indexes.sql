-- migrations/0009_read_surface_indexes.sql
--
-- Indexes, plus one one-time purge. The indexes change no table, so they and
-- the deploy that uses them are safe in either order: the new code is correct
-- without them and merely slower, and they are inert without the new code.

-- Encounters and follow-ups gain person_name in this release, and updated_at
-- joins the shared encounter columns. Stored idempotency responses predate
-- both, so a replayed key would return the old shape. Decided with Matt on
-- 2026-08-28: purge the store once instead of living with mixed shapes for
-- the 30-day retention window. The cost is that writes made before this
-- migration lose replay protection; retries arrive seconds apart in practice,
-- so applying this at a quiet moment, immediately before the deploy, closes
-- the window. This does not disturb the delete_person redaction rule from
-- plan 1, which governs what gets stored, not what gets deleted.
DELETE FROM idempotency_keys;

-- list_records(updated_after: ...) on all three durable scopes.
CREATE INDEX idx_people_updated ON people(updated_at);
CREATE INDEX idx_encounters_updated ON encounters(updated_at);
CREATE INDEX idx_followups_updated ON followups(updated_at);

-- list_records(tags: [...]) walks tag to person. person_tags has only
-- PRIMARY KEY (person_id, tag_id), which cannot serve that direction.
CREATE INDEX idx_person_tags_tag ON person_tags(tag_id, person_id);

-- list_roster_entries(role: ...).
--
-- Leading with roster_source_id means this index CANNOT serve a role-only
-- query, and source_key is optional on that tool. Two columns in this order
-- because the realistic call names a source. If role-only listing turns out to
-- matter, it needs its own index on (role), not a reordering of this one.
CREATE INDEX idx_roster_entries_role ON roster_entries(roster_source_id, role);

-- Deliberately absent: anything for list_roster_entries(promoted: ...).
-- "Promoted" is not a column. It is a correlated lookup into person_sources on
-- (source_key, external_row_key), and that side is already covered by the
-- UNIQUE constraint in migration 0002. There is nothing on roster_entries to
-- index, so that filter scans the source's rows. At 798 that is fine, and
-- saying so here is better than a future reader assuming an index was missed.
