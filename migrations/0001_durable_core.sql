CREATE TABLE people (
  id                TEXT PRIMARY KEY NOT NULL,
  full_name         TEXT NOT NULL,
  preferred_name    TEXT,
  job_title         TEXT,
  organization      TEXT,
  notes             TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_people_archived ON people(archived_at);
CREATE INDEX idx_people_organization ON people(organization);

-- `value` is what the user typed and what is displayed back. `normalized_value`
-- is what is matched on, written by `add_contact` using the pinned rules in
-- src/normalize.ts. Both are stored because an email is displayed as given and
-- compared as folded, and deriving one from the other at query time would mean
-- SQLite's ASCII-only LOWER() standing in for NFKC.
CREATE TABLE person_contacts (
  id               TEXT PRIMARY KEY NOT NULL,
  person_id        TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  contact_type     TEXT NOT NULL CHECK (contact_type IN ('email', 'phone')),
  value            TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  label            TEXT,
  -- Only meaningful where a channel can be confirmed; null everywhere else.
  verified_at      TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (person_id, contact_type, normalized_value)
);

CREATE INDEX idx_person_contacts_person ON person_contacts(person_id);

-- On the NORMALIZED value, not the raw one. `create_person`'s duplicate check
-- matches on email and would otherwise scan every contact row, and this index
-- is also what makes "who is bob@example.com" answerable through search_people.
CREATE INDEX idx_person_contacts_normalized ON person_contacts(contact_type, normalized_value);

CREATE TABLE person_links (
  id         TEXT PRIMARY KEY NOT NULL,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  link_type  TEXT NOT NULL,
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (person_id, link_type, url)
);

CREATE INDEX idx_person_links_person ON person_links(person_id);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE person_tags (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, tag_id)
);
