CREATE TABLE IF NOT EXISTS opportunities (
    id text PRIMARY KEY,
    source text NOT NULL,
    external_id text NOT NULL,
    item jsonb NOT NULL,
    UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS proposal_revisions (
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    version integer NOT NULL CHECK (version > 0),
    proposal text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (opportunity_id, version)
);
CREATE TABLE IF NOT EXISTS source_receipts (
    source text NOT NULL,
    receipt_id text NOT NULL,
    opportunity_id text NOT NULL REFERENCES opportunities(id),
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, receipt_id)
);
CREATE TABLE IF NOT EXISTS source_health (
    source text PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('not_connected', 'ok', 'failed')),
    checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS digest_outbox (
    id text PRIMARY KEY,
    local_date date NOT NULL,
    recipient text NOT NULL,
    snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attempted', 'sent', 'unknown')),
    created_at timestamptz NOT NULL DEFAULT now(),
    attempted_at timestamptz,
    finished_at timestamptz,
    delivery_receipt text,
    CHECK (status <> 'sent' OR length(trim(delivery_receipt)) > 0 AND delivery_receipt IS NOT NULL),
    UNIQUE(local_date, recipient)
);
CREATE OR REPLACE FUNCTION protect_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.local_date IS DISTINCT FROM OLD.local_date
       OR NEW.recipient IS DISTINCT FROM OLD.recipient OR NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
        RAISE EXCEPTION 'Digest identity and snapshot are immutable';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'pending' AND NEW.status = 'attempted') OR
        (OLD.status = 'attempted' AND NEW.status IN ('sent', 'unknown'))
    ) THEN
        RAISE EXCEPTION 'Unsafe digest state transition';
    END IF;
    RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER digest_immutable BEFORE UPDATE ON digest_outbox
FOR EACH ROW EXECUTE FUNCTION protect_digest();
