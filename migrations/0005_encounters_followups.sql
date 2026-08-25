CREATE TABLE encounters (
  id           TEXT PRIMARY KEY NOT NULL,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  occurred_on  TEXT NOT NULL,
  occurred_at  TEXT,
  location     TEXT,
  event        TEXT,
  summary      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_encounters_person ON encounters(person_id, occurred_on DESC, id);
CREATE INDEX idx_encounters_event ON encounters(event);

CREATE TABLE followups (
  id           TEXT PRIMARY KEY NOT NULL,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  due_on       TEXT NOT NULL,
  note         TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_followups_open ON followups(due_on) WHERE completed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX idx_followups_person ON followups(person_id);
