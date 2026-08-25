-- A logical roster that can be imported more than once. THE ROW IS PERMANENT.
-- Purging deletes its entries and stamps `purged_at`; it never deletes this row.
-- If source keys could be recycled, an agent that purges `wcus-attendees` and
-- later imports the 2027 roster under the same obvious key would produce
-- (source_key, external_row_key) collisions against 2026 provenance, and
-- promote_roster_entry would return a 2026 person as its strongest evidence for
-- a 2027 row. That is a silent write against the wrong person, which the spec
-- names as its most likely real failure.
CREATE TABLE roster_sources (
  id         TEXT PRIMARY KEY NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  event      TEXT,
  url        TEXT,
  created_at TEXT NOT NULL,
  purged_at  TEXT
);

-- One attempt against a source. Bookkeeping and progress, not a lock.
-- There is no input hash: under the chunked protocol the server never sees the
-- whole input, so a hash of it cannot exist.
-- There is no `full_coverage` and no `retired_count`. Nothing is ever retired.
CREATE TABLE import_runs (
  id               TEXT PRIMARY KEY NOT NULL,
  roster_source_id TEXT NOT NULL REFERENCES roster_sources(id) ON DELETE CASCADE,
  format           TEXT NOT NULL CHECK (format IN ('csv', 'json', 'text')),
  status           TEXT NOT NULL CHECK (status IN ('open', 'committed', 'abandoned')),
  expected_total   INTEGER NOT NULL,
  next_offset      INTEGER NOT NULL DEFAULT 0,
  inserted_count   INTEGER NOT NULL DEFAULT 0,
  updated_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  finished_at      TEXT
);

CREATE INDEX idx_import_runs_source ON import_runs(roster_source_id);

-- Finding a source's latest COMPLETED run is the hot path behind every
-- staleness annotation, in search results and in list_roster_sources alike.
CREATE INDEX idx_import_runs_latest_completed
  ON import_runs(roster_source_id, status, finished_at DESC);

-- The imported row. `external_row_key` is identity; `content_hash` is change
-- detection. They are two different values and conflating them is the defect
-- the fifth spec revision exists to fix: a whole-row hash used as identity
-- makes an edited row a NEW row, so the edit is undetectable by construction.
-- There is no `retired_at`. A row the latest completed run did not see is
-- derived as stale from `last_seen_run_id`, and nothing acts on it.
CREATE TABLE roster_entries (
  id                 TEXT PRIMARY KEY NOT NULL,
  roster_source_id   TEXT NOT NULL REFERENCES roster_sources(id) ON DELETE CASCADE,
  external_row_key   TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  full_name          TEXT NOT NULL,
  preferred_name     TEXT,
  job_title          TEXT,
  organization       TEXT,
  email              TEXT,
  role               TEXT,
  source_url         TEXT NOT NULL,
  source_captured_at TEXT NOT NULL,
  raw_record         TEXT NOT NULL,
  last_seen_run_id   TEXT NOT NULL REFERENCES import_runs(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (roster_source_id, external_row_key)
);

CREATE INDEX idx_roster_entries_source ON roster_entries(roster_source_id);
CREATE INDEX idx_roster_entries_last_seen ON roster_entries(last_seen_run_id);

-- Staged rows are deliberately NOT FTS-indexed. `search_people` with
-- scope: roster runs a bounded LIKE scan instead. An FTS index over staged data
-- would fire triggers on every imported row, spending exactly the CPU budget
-- the import protocol is fighting for. These two indexes make that scan bounded.
CREATE INDEX idx_roster_entries_name ON roster_entries(full_name);
CREATE INDEX idx_roster_entries_email ON roster_entries(email);

-- Durable provenance, COPIED at promotion rather than referenced.
-- Both a canonical snapshot and its hash, because they do different jobs: the
-- hash detects that the roster row changed since promotion, and the snapshot is
-- the only thing that can still show what was captured once the staged row is
-- purged. A hash alone is worthless after the source disappears, which is
-- exactly when provenance matters.
-- `source_label` and `source_event` are copied as they read at promotion time,
-- for the same reason: they must survive the source being relabelled.
CREATE TABLE person_sources (
  id                  TEXT PRIMARY KEY NOT NULL,
  person_id           TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_key          TEXT NOT NULL,
  external_row_key    TEXT NOT NULL,
  source_label        TEXT NOT NULL,
  source_event        TEXT,
  source_url          TEXT NOT NULL,
  source_captured_at  TEXT NOT NULL,
  raw_record_snapshot TEXT NOT NULL,
  -- NOT a hash of the snapshot beside it. This is the `content_hash` the staged
  -- row carried at promotion, so `matches_current` can compare it against that
  -- row's current `content_hash` and answer "has this roster row changed since
  -- we promoted from it". The previous name, `raw_record_hash`, promised
  -- something the column does not hold, and anyone in plan 3 verifying the
  -- snapshot against it would find they never match.
  content_hash_at_promotion TEXT NOT NULL,
  promoted_at         TEXT NOT NULL,
  -- Two people promoted from one roster row is a bug, not a tolerated
  -- duplicate. This constraint is what replaced `person_roster_entries`.
  UNIQUE (source_key, external_row_key)
);

CREATE INDEX idx_person_sources_person ON person_sources(person_id);
