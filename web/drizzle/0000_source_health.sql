CREATE TABLE "source_health" (
	"source" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"checked_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "source_health_status" CHECK ("source_health"."status" in ('not_connected', 'ok', 'failed', 'waiting'))
);
