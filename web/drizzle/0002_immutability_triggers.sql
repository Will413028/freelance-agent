-- Postgres equivalents of the six SQLite triggers in backend/src/freelance/platform/schema/001_sqlite.sql.
-- Messages match the SQLite RAISE(ABORT, ...) text; SQLite "IS NOT" becomes IS DISTINCT FROM.
CREATE FUNCTION digest_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.local_date IS DISTINCT FROM OLD.local_date
     OR NEW.recipient IS DISTINCT FROM OLD.recipient OR NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'Digest identity and snapshot are immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status = 'attempted') OR
       (OLD.status = 'attempted' AND NEW.status IN ('sent', 'unknown'))) THEN
    RAISE EXCEPTION 'Unsafe digest state transition';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER digest_immutable BEFORE UPDATE ON digest_outbox FOR EACH ROW EXECUTE FUNCTION digest_immutable();
--> statement-breakpoint
CREATE FUNCTION draft_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Proposal versions are immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER draft_revision_immutable BEFORE UPDATE ON proposal_draft_revisions FOR EACH ROW EXECUTE FUNCTION draft_revision_immutable();
--> statement-breakpoint
CREATE FUNCTION draft_revision_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Proposal versions must be retained'; END $$;
--> statement-breakpoint
CREATE TRIGGER draft_revision_retained BEFORE DELETE ON proposal_draft_revisions FOR EACH ROW EXECUTE FUNCTION draft_revision_retained();
--> statement-breakpoint
CREATE FUNCTION submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
     OR NEW.draft_version IS DISTINCT FROM OLD.draft_version OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.request_payload IS DISTINCT FROM OLD.request_payload THEN
    RAISE EXCEPTION 'Submission identity and snapshot are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'prepared' AND NEW.status IN ('approved', 'cancelled')) OR
       (OLD.status = 'approved' AND NEW.status IN ('attempted', 'cancelled')) OR
       (OLD.status = 'attempted' AND NEW.status IN ('accepted', 'rejected', 'unknown'))) THEN
    RAISE EXCEPTION 'Unsafe submission transition';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER submission_immutable BEFORE UPDATE ON submission_intents FOR EACH ROW EXECUTE FUNCTION submission_immutable();
--> statement-breakpoint
CREATE FUNCTION submission_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Submission events are immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER submission_event_immutable BEFORE UPDATE ON submission_events FOR EACH ROW EXECUTE FUNCTION submission_event_immutable();
--> statement-breakpoint
CREATE FUNCTION submission_event_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Submission events must be retained'; END $$;
--> statement-breakpoint
CREATE TRIGGER submission_event_retained BEFORE DELETE ON submission_events FOR EACH ROW EXECUTE FUNCTION submission_event_retained();
--> statement-breakpoint
-- SQLite has no TRUNCATE; in Postgres it skips row DELETE triggers, so the retained ledgers block it too.
CREATE TRIGGER draft_revision_retained_truncate BEFORE TRUNCATE ON proposal_draft_revisions FOR EACH STATEMENT EXECUTE FUNCTION draft_revision_retained();
--> statement-breakpoint
CREATE TRIGGER submission_event_retained_truncate BEFORE TRUNCATE ON submission_events FOR EACH STATEMENT EXECUTE FUNCTION submission_event_retained();
