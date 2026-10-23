CREATE TABLE IF NOT EXISTS opportunities (
    id text PRIMARY KEY,
    source text NOT NULL,
    external_id text NOT NULL,
    item text NOT NULL,
    UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS proposal_revisions (
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    version integer NOT NULL CHECK (version > 0),
    proposal text NOT NULL,
    fingerprint text NOT NULL,
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (opportunity_id, version)
);
CREATE TABLE IF NOT EXISTS source_receipts (
    source text NOT NULL,
    receipt_id text NOT NULL,
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    received_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source, receipt_id)
);
CREATE TABLE IF NOT EXISTS source_health (
    source text PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('not_connected', 'ok', 'failed', 'waiting')),
    checked_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS digest_outbox (
    id text PRIMARY KEY,
    local_date text NOT NULL,
    recipient text NOT NULL,
    snapshot text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attempted', 'sent', 'unknown')),
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempted_at text,
    finished_at text,
    delivery_receipt text,
    CHECK (status <> 'sent' OR length(trim(delivery_receipt)) > 0 AND delivery_receipt IS NOT NULL),
    UNIQUE(local_date, recipient)
);
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
CREATE TABLE IF NOT EXISTS daily_runs (
    local_date text NOT NULL,
    recipient text NOT NULL,
    status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    started_at text NOT NULL,
    finished_at text,
    result text,
    PRIMARY KEY (local_date, recipient)
);
CREATE TABLE IF NOT EXISTS opportunity_tracking (
    opportunity_id text PRIMARY KEY REFERENCES opportunities(id),
    state text NOT NULL
);
CREATE TABLE IF NOT EXISTS tracking_events (
    id integer PRIMARY KEY AUTOINCREMENT,
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    revision integer NOT NULL,
    state text NOT NULL,
    created_at text NOT NULL,
    UNIQUE(opportunity_id, revision)
);
CREATE TABLE IF NOT EXISTS ai_draft_attempts (
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    fingerprint text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    local_date text NOT NULL,
    recipient text NOT NULL,
    status text NOT NULL CHECK (status IN ('attempted', 'succeeded', 'failed', 'stale')),
    attempted_at text NOT NULL,
    finished_at text,
    reason text,
    priority text NOT NULL CHECK (priority IN ('interested', 'prewrite', 'legacy')),
    PRIMARY KEY (opportunity_id, fingerprint, priority)
);
CREATE INDEX IF NOT EXISTS ai_draft_attempts_local_date ON ai_draft_attempts(local_date);
CREATE TABLE IF NOT EXISTS discovery_settings (
    id integer PRIMARY KEY CHECK (id = 1),
    revision integer NOT NULL,
    settings text NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_sync_state (
    source text NOT NULL,
    recipient text NOT NULL,
    state text NOT NULL,
    PRIMARY KEY (source, recipient)
);
CREATE TABLE IF NOT EXISTS mail_ingestion (
    source text NOT NULL,
    recipient text NOT NULL,
    message_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('processed', 'rejected', 'conflict')),
    reason text,
    retry_pending integer NOT NULL DEFAULT 0 CHECK (retry_pending IN (0, 1)),
    checked_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source, recipient, message_id)
);
CREATE TABLE IF NOT EXISTS mail_content_versions (
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    fingerprint text NOT NULL,
    job text NOT NULL,
    PRIMARY KEY (opportunity_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS manual_applications (
    id text PRIMARY KEY,
    title text NOT NULL,
    contact text NOT NULL,
    url text,
    applied_on text NOT NULL,
    stage text NOT NULL CHECK(stage IN ('applied','negotiating','won','closed')),
    follow_up_on text,
    note text NOT NULL,
    revision integer NOT NULL CHECK(revision > 0),
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    request_id text NOT NULL UNIQUE,
    request_payload text NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_application_opportunities (
    application_id text NOT NULL REFERENCES manual_applications(id),
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    PRIMARY KEY(application_id,opportunity_id)
);
CREATE INDEX IF NOT EXISTS manual_application_links ON manual_application_opportunities(opportunity_id);
CREATE TABLE IF NOT EXISTS manual_application_events (
    application_id text NOT NULL REFERENCES manual_applications(id),
    revision integer NOT NULL,
    action text NOT NULL CHECK(action IN ('created','updated','deleted')),
    state text NOT NULL,
    created_at text NOT NULL,
    PRIMARY KEY(application_id,revision)
);
CREATE TABLE IF NOT EXISTS clients (
    id text PRIMARY KEY,
    name text NOT NULL,
    note text NOT NULL,
    revision integer NOT NULL CHECK(revision > 0),
    created_at text NOT NULL,
    updated_at text NOT NULL,
    archived_at text,
    request_id text NOT NULL UNIQUE,
    request_payload text NOT NULL
);
CREATE TABLE IF NOT EXISTS client_contacts (
    id text PRIMARY KEY,
    client_id text NOT NULL REFERENCES clients(id),
    name text NOT NULL,
    address text NOT NULL,
    note text NOT NULL,
    revision integer NOT NULL CHECK(revision > 0),
    created_at text NOT NULL,
    updated_at text NOT NULL,
    archived_at text,
    request_id text NOT NULL UNIQUE,
    request_payload text NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_by_client ON client_contacts(client_id,name,id);
CREATE TABLE IF NOT EXISTS application_parties (
    application_id text PRIMARY KEY REFERENCES manual_applications(id),
    client_id text NOT NULL REFERENCES clients(id),
    contact_id text REFERENCES client_contacts(id),
    snapshot text NOT NULL
);
CREATE INDEX IF NOT EXISTS application_parties_by_client ON application_parties(client_id,application_id);
CREATE TABLE IF NOT EXISTS proposal_templates (
    id text PRIMARY KEY, name text NOT NULL, body text NOT NULL,
    revision integer NOT NULL CHECK(revision > 0), created_at text NOT NULL, updated_at text NOT NULL,
    archived_at text, request_id text NOT NULL UNIQUE, request_payload text NOT NULL
);
CREATE TABLE IF NOT EXISTS proposal_drafts (
    id text PRIMARY KEY, title text NOT NULL, revision integer NOT NULL CHECK(revision > 0),
    source_tokens text NOT NULL, source_snapshot text NOT NULL, party text NOT NULL,
    created_at text NOT NULL, updated_at text NOT NULL, archived_at text,
    request_id text NOT NULL UNIQUE, request_payload text NOT NULL
);
CREATE TABLE IF NOT EXISTS proposal_draft_revisions (
    draft_id text NOT NULL REFERENCES proposal_drafts(id), version integer NOT NULL CHECK(version > 0),
    body text NOT NULL, values_json text NOT NULL, missing text NOT NULL, template_snapshot text NOT NULL,
    request_id text NOT NULL, request_payload text NOT NULL, created_at text NOT NULL,
    PRIMARY KEY(draft_id,version), UNIQUE(draft_id,request_id)
);
CREATE TRIGGER IF NOT EXISTS draft_revision_immutable BEFORE UPDATE ON proposal_draft_revisions
BEGIN SELECT RAISE(ABORT,'Proposal versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS draft_revision_retained BEFORE DELETE ON proposal_draft_revisions
BEGIN SELECT RAISE(ABORT,'Proposal versions must be retained'); END;
CREATE TABLE IF NOT EXISTS submission_intents (
    id text PRIMARY KEY, draft_id text NOT NULL REFERENCES proposal_drafts(id), draft_version integer NOT NULL,
    snapshot text NOT NULL, snapshot_hash text NOT NULL, approval_hash text,
    status text NOT NULL CHECK(status IN ('prepared','approved','attempted','accepted','rejected','unknown','cancelled')),
    revision integer NOT NULL CHECK(revision > 0), created_at text NOT NULL, updated_at text NOT NULL,
    attempted_at text, finished_at text, receipt text, reconciliation text,
    request_id text NOT NULL UNIQUE, request_payload text NOT NULL,
    FOREIGN KEY(draft_id,draft_version) REFERENCES proposal_draft_revisions(draft_id,version)
);
CREATE TABLE IF NOT EXISTS submission_events (
    intent_id text NOT NULL REFERENCES submission_intents(id), revision integer NOT NULL,
    action text NOT NULL, evidence text NOT NULL, created_at text NOT NULL, PRIMARY KEY(intent_id,revision)
);
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
CREATE TRIGGER IF NOT EXISTS submission_event_immutable BEFORE UPDATE ON submission_events
BEGIN SELECT RAISE(ABORT,'Submission events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS submission_event_retained BEFORE DELETE ON submission_events
BEGIN SELECT RAISE(ABORT,'Submission events must be retained'); END;
CREATE TABLE IF NOT EXISTS application_proposals (
    application_id text PRIMARY KEY REFERENCES manual_applications(id),
    draft_id text NOT NULL, draft_version integer NOT NULL, submission_id text UNIQUE REFERENCES submission_intents(id),
    snapshot text NOT NULL,
    FOREIGN KEY(draft_id,draft_version) REFERENCES proposal_draft_revisions(draft_id,version)
);
