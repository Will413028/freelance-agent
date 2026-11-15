ALTER TABLE "listings" ADD COLUMN "source_kept" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "gone_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "listings_shown" ON "listings" USING btree ("id") WHERE "listings"."source_kept" and not "listings"."hard_excluded";