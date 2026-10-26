-- The six immutability triggers of backend/src/freelance/platform/schema/001_sqlite.sql, verbatim
-- (tests/schema.test.ts compares them), then the D1-only ones. SQLite has no TRUNCATE; DELETE without
-- WHERE still fires the row triggers when a table has them.
CREATE TRIGGER IF NOT EXISTS digest_immutable BEFORE UPDATE ON digest_outbox
BEGIN
    SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.local_date IS NOT OLD.local_date
        OR NEW.recipient IS NOT OLD.recipient OR NEW.snapshot IS NOT OLD.snapshot
        THEN RAISE(ABORT, 'Digest identity and snapshot are immutable') END;
    SELECT CASE WHEN NEW.status != OLD.status AND NOT (
        (OLD.status = 'pending' AND NEW.status = 'attempted') OR
        (OLD.status = 'attempted' AND NEW.status IN ('sent', 'unknown'))
    ) THEN RAISE(ABORT, 'Unsafe digest state transition') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS draft_revision_immutable BEFORE UPDATE ON proposal_draft_revisions
BEGIN SELECT RAISE(ABORT,'Proposal versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS draft_revision_retained BEFORE DELETE ON proposal_draft_revisions
BEGIN SELECT RAISE(ABORT,'Proposal versions must be retained'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS submission_immutable BEFORE UPDATE ON submission_intents
BEGIN
    SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.draft_id IS NOT OLD.draft_id
        OR NEW.draft_version IS NOT OLD.draft_version OR NEW.snapshot IS NOT OLD.snapshot
        OR NEW.snapshot_hash IS NOT OLD.snapshot_hash OR NEW.request_id IS NOT OLD.request_id
        OR NEW.request_payload IS NOT OLD.request_payload
        THEN RAISE(ABORT,'Submission identity and snapshot are immutable') END;
    SELECT CASE WHEN NEW.status IS NOT OLD.status AND NOT (
        (OLD.status='prepared' AND NEW.status IN ('approved','cancelled')) OR
        (OLD.status='approved' AND NEW.status IN ('attempted','cancelled')) OR
        (OLD.status='attempted' AND NEW.status IN ('accepted','rejected','unknown'))
    ) THEN RAISE(ABORT,'Unsafe submission transition') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS submission_event_immutable BEFORE UPDATE ON submission_events
BEGIN SELECT RAISE(ABORT,'Submission events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS submission_event_retained BEFORE DELETE ON submission_events
BEGIN SELECT RAISE(ABORT,'Submission events must be retained'); END;
--> statement-breakpoint
-- A ledger row records what a stored, immutable snapshot announced (D15). A missing row would let the
-- next digest announce that job again, so rows are never edited or removed; a copy is rebuilt into an
-- empty table by the one-time import, which drops and recreates the tables.
CREATE TRIGGER IF NOT EXISTS digest_novelty_immutable BEFORE UPDATE ON digest_novelty
BEGIN SELECT RAISE(ABORT,'Digest novelty is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS digest_novelty_retained BEFORE DELETE ON digest_novelty
BEGIN SELECT RAISE(ABORT,'Digest novelty is immutable'); END;
--> statement-breakpoint
-- Any row reaching guard is a failed precondition: abort the batch. The message is a literal because
-- older SQLite versions accept nothing else in RAISE.
CREATE TRIGGER IF NOT EXISTS guard_failed BEFORE INSERT ON guard
BEGIN SELECT RAISE(ABORT, 'guard failed'); END;
