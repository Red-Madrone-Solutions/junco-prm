CREATE VIRTUAL TABLE encounters_fts USING fts5(
  id UNINDEXED,
  summary,
  location,
  event
);

CREATE TRIGGER encounters_fts_ai AFTER INSERT ON encounters BEGIN
  INSERT INTO encounters_fts (id, summary, location, event)
  VALUES (new.id, new.summary, new.location, new.event);
END;

CREATE TRIGGER encounters_fts_ad AFTER DELETE ON encounters BEGIN
  DELETE FROM encounters_fts WHERE id = old.id;
END;

CREATE TRIGGER encounters_fts_au AFTER UPDATE ON encounters BEGIN
  DELETE FROM encounters_fts WHERE id = old.id;
  INSERT INTO encounters_fts (id, summary, location, event)
  VALUES (new.id, new.summary, new.location, new.event);
END;
