CREATE VIRTUAL TABLE people_fts USING fts5(
  id UNINDEXED,
  full_name,
  preferred_name,
  organization,
  job_title,
  notes
);

CREATE TRIGGER people_fts_ai AFTER INSERT ON people BEGIN
  INSERT INTO people_fts (id, full_name, preferred_name, organization, job_title, notes)
  VALUES (new.id, new.full_name, new.preferred_name, new.organization, new.job_title, new.notes);
END;

CREATE TRIGGER people_fts_ad AFTER DELETE ON people BEGIN
  DELETE FROM people_fts WHERE id = old.id;
END;

CREATE TRIGGER people_fts_au AFTER UPDATE ON people BEGIN
  DELETE FROM people_fts WHERE id = old.id;
  INSERT INTO people_fts (id, full_name, preferred_name, organization, job_title, notes)
  VALUES (new.id, new.full_name, new.preferred_name, new.organization, new.job_title, new.notes);
END;
