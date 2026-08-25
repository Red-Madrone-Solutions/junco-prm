-- Every staleness annotation in the system compares against "the source's
-- latest COMMITTED run." Before this migration nothing stored that fact
-- directly: staleness was derived from last_seen_run_id, which stamps
-- unconditionally on every write, open run included. An abandoned run then
-- inverts staleness for every row it touched - see the note above
-- roster_entries in 0002 for the mechanism this replaces and why it was wrong.
--
-- committed_run_id is promoted from last_seen_run_id by finalize_import, in
-- the same statement batch that marks the run committed. Nullable, because a
-- row a run has written but never committed has not been confirmed by any
-- committed run, and NULL is the honest representation of that - not the open
-- run's id, which would read as current, and not the previous committed run's
-- id, which the write never claimed.
ALTER TABLE roster_entries ADD COLUMN committed_run_id TEXT REFERENCES import_runs(id);

CREATE INDEX idx_roster_entries_committed_run ON roster_entries(committed_run_id);
