-- `response_json` holds a full copy of whatever the tool returned, which for
-- most writes is a complete person record. `subject_id` is what makes that
-- erasable: `delete_person` scrubs every row whose subject is the person being
-- deleted, in the same batch as the deletion itself.
--
-- Without it this table is a shadow copy of the PRM that `delete_person` cannot
-- reach - an erasure tool that leaves the erased person's name, notes, and
-- contact details sitting in an operational table.
--
-- Nullable, because tools that are not about one person (import_roster,
-- finalize_import, purge_roster_source) have no subject to record.
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY NOT NULL,
  tool          TEXT NOT NULL,
  subject_id    TEXT,
  request_hash  TEXT NOT NULL,
  response_json TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);

CREATE INDEX idx_idempotency_subject ON idempotency_keys(subject_id);

CREATE TABLE confirmations (
  token      TEXT PRIMARY KEY NOT NULL,
  action     TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  preview    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE INDEX idx_confirmations_expiry ON confirmations(expires_at);

-- One row per committed import chunk. `payload_hash` is over the chunk's rows,
-- so a retry carrying the same rows replays, while a DIFFERENT chunk presenting
-- an already-consumed offset is a `conflict` rather than a silent overwrite.
-- The primary key is the pair the protocol is idempotent on.
CREATE TABLE import_chunk_receipts (
  run_id       TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  offset_value INTEGER NOT NULL,
  row_count    INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (run_id, offset_value)
);
