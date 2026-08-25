-- list_due paginates with a full keyset on (due_on, id), but 0005's
-- idx_followups_open only covers due_on. Replace it with an index over the
-- same column list the keyset WHERE and ORDER BY both use, so the query that
-- answers "what am I forgetting" doesn't sort the open set on every call.
DROP INDEX idx_followups_open;
CREATE INDEX idx_followups_open ON followups(due_on, id) WHERE completed_at IS NULL AND cancelled_at IS NULL;
