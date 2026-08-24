-- Two tables, shaped like the real ones only where the shape affects the
-- measurement. `probe` exists to be written to in a batch. `shaped` carries the
-- same column count as the real `roster_entries` so the 100-bound-parameter
-- arithmetic is measured against a real row width rather than a guessed one.

CREATE TABLE IF NOT EXISTS probe (
  id TEXT PRIMARY KEY,
  n  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shaped (
  id                 TEXT PRIMARY KEY,
  roster_source_id   TEXT NOT NULL,
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
  last_seen_run_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
