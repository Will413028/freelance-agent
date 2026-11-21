ALTER TABLE "listing_versions" ADD COLUMN "registration_deadline" date;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD COLUMN "prize_text" text;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD COLUMN "online" boolean;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD COLUMN "invite_only" boolean;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD COLUMN "hackathon" boolean;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "registration_deadline" date;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "prize_text" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "online" boolean;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "invite_only" boolean;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "hackathon" boolean;