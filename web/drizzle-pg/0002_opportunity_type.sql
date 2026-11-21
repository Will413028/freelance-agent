DROP INDEX "listings_shown";--> statement-breakpoint
ALTER TABLE "listing_versions" ADD COLUMN "opportunity_type" text DEFAULT 'job' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "opportunity_type" text DEFAULT 'job' NOT NULL;--> statement-breakpoint
CREATE INDEX "listings_shown" ON "listings" USING btree ("opportunity_type","id") WHERE "listings"."source_kept" and not "listings"."hard_excluded";