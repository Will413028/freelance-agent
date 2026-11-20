-- contract: run_sources.status drops 'waiting', which no image ever wrote (runDaily writes ok and failed only; design review 12e W3).
ALTER TABLE "run_sources" DROP CONSTRAINT "run_sources_status";--> statement-breakpoint
ALTER TABLE "listing_versions" ADD COLUMN "evaluated_with" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "evaluated_with" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_status" CHECK ("run_sources"."status" in ('ok', 'failed'));