CREATE TABLE "digest_novelty" (
	"digest_id" text COLLATE "C" NOT NULL,
	"key" text COLLATE "C" NOT NULL,
	"fingerprint" text COLLATE "C" NOT NULL,
	CONSTRAINT "digest_novelty_key_fingerprint_digest_id_pk" PRIMARY KEY("key","fingerprint","digest_id")
);
--> statement-breakpoint
ALTER TABLE "digest_novelty" ADD CONSTRAINT "digest_novelty_digest_id_digest_outbox_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digest_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A ledger row records what a stored, immutable snapshot announced. A missing row would let the next
-- digest announce that job again, so rows are never edited or removed; a copy is rebuilt into an
-- empty table (converge drops the schema, replay uses temporary tables without triggers).
CREATE FUNCTION digest_novelty_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Digest novelty is immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER digest_novelty_immutable BEFORE UPDATE OR DELETE ON digest_novelty FOR EACH ROW EXECUTE FUNCTION digest_novelty_immutable();
--> statement-breakpoint
CREATE TRIGGER digest_novelty_retained_truncate BEFORE TRUNCATE ON digest_novelty FOR EACH STATEMENT EXECUTE FUNCTION digest_novelty_immutable();
