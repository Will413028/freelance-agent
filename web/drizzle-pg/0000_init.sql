CREATE TABLE "listing_feedback" (
	"listing_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_feedback_state" CHECK ("listing_feedback"."state" in ('neutral', 'interested', 'skipped')),
	CONSTRAINT "listing_feedback_revision" CHECK ("listing_feedback"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "listing_feedback_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "listing_feedback_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"listing_id" text NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_feedback_events_state" CHECK ("listing_feedback_events"."state" in ('neutral', 'interested', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "listing_versions" (
	"listing_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"raw" jsonb NOT NULL,
	"title" text NOT NULL,
	"company" text,
	"description" text,
	"url" text,
	"canonical_url" text,
	"location" text,
	"kind" text,
	"currency" text,
	"budget_min" double precision,
	"budget_max" double precision,
	"weekly_hours" double precision,
	"taiwan_eligible" boolean,
	"timezone_compatible" boolean,
	"complete" boolean,
	"listing_closed" boolean,
	"published_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"category" text NOT NULL,
	"category_score" smallint NOT NULL,
	"hard_excluded" boolean NOT NULL,
	"confirmed_base" smallint NOT NULL,
	"fixed_twd_max" double precision,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_versions_listing_id_fingerprint_pk" PRIMARY KEY("listing_id","fingerprint"),
	CONSTRAINT "listing_versions_kind" CHECK ("listing_versions"."kind" in ('fixed', 'hourly', 'contract', 'full_time')),
	CONSTRAINT "listing_versions_confirmed_base" CHECK ("listing_versions"."confirmed_base" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"raw" jsonb NOT NULL,
	"title" text NOT NULL,
	"company" text,
	"description" text,
	"url" text,
	"canonical_url" text,
	"location" text,
	"kind" text,
	"currency" text,
	"budget_min" double precision,
	"budget_max" double precision,
	"weekly_hours" double precision,
	"taiwan_eligible" boolean,
	"timezone_compatible" boolean,
	"complete" boolean,
	"listing_closed" boolean,
	"published_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"category" text NOT NULL,
	"category_score" smallint NOT NULL,
	"hard_excluded" boolean NOT NULL,
	"confirmed_base" smallint NOT NULL,
	"fixed_twd_max" double precision,
	"first_seen_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_kind" CHECK ("listings"."kind" in ('fixed', 'hourly', 'contract', 'full_time')),
	CONSTRAINT "listings_confirmed_base" CHECK ("listings"."confirmed_base" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "mail_cursors" (
	"source" text NOT NULL,
	"recipient" text NOT NULL,
	"cursor" text,
	"after" text,
	"head" text,
	CONSTRAINT "mail_cursors_source_recipient_pk" PRIMARY KEY("source","recipient")
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"source" text NOT NULL,
	"recipient" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"disposition" text DEFAULT 'none' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_source_recipient_message_id_pk" PRIMARY KEY("source","recipient","message_id"),
	CONSTRAINT "mail_messages_status" CHECK ("mail_messages"."status" in ('processed', 'rejected')),
	CONSTRAINT "mail_messages_disposition" CHECK ("mail_messages"."disposition" in ('none', 'retry', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "run_sources" (
	"run_id" integer NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"error" text,
	"tier" text DEFAULT 'plain' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_sources_run_id_source_pk" PRIMARY KEY("run_id","source"),
	CONSTRAINT "run_sources_status" CHECK ("run_sources"."status" in ('ok', 'waiting', 'failed')),
	CONSTRAINT "run_sources_tier" CHECK ("run_sources"."tier" in ('plain', 'browser_like', 'browser'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"local_date" date NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_local_date_unique" UNIQUE("local_date"),
	CONSTRAINT "runs_status" CHECK ("runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"max_weekly_hours" smallint,
	"min_fixed_twd" integer NOT NULL,
	"categories" text[] NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 1),
	CONSTRAINT "settings_revision" CHECK ("settings"."revision" > 0),
	CONSTRAINT "settings_max_weekly_hours" CHECK ("settings"."max_weekly_hours" between 1 and 168),
	CONSTRAINT "settings_min_fixed_twd" CHECK ("settings"."min_fixed_twd" between 0 and 10000000),
	CONSTRAINT "settings_categories" CHECK (cardinality("settings"."categories") > 0 and "settings"."categories" <@ array['AI agent', 'AI 整合／自動化', '後端／API', '全端 MVP']::text[])
);
--> statement-breakpoint
ALTER TABLE "listing_feedback" ADD CONSTRAINT "listing_feedback_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_feedback_events" ADD CONSTRAINT "listing_feedback_events_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_feedback_events_listing_revision" ON "listing_feedback_events" USING btree ("listing_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_source_external_id" ON "listings" USING btree ("source","external_id");