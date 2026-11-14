CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"local_date" date NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_local_date_unique" UNIQUE("local_date"),
	CONSTRAINT "runs_status" CHECK ("runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "listings_source_external_id" ON "listings" USING btree ("source","external_id");