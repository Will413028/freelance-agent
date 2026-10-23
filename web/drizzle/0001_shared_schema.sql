CREATE TABLE "ai_draft_attempts" (
	"opportunity_id" text COLLATE "C" NOT NULL,
	"fingerprint" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"local_date" text COLLATE "C" NOT NULL,
	"recipient" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" NOT NULL,
	"attempted_at" text COLLATE "C" NOT NULL,
	"finished_at" text COLLATE "C",
	"reason" text COLLATE "C",
	"priority" text COLLATE "C" NOT NULL,
	CONSTRAINT "ai_draft_attempts_opportunity_id_fingerprint_priority_pk" PRIMARY KEY("opportunity_id","fingerprint","priority"),
	CONSTRAINT "ai_draft_attempts_version" CHECK ("ai_draft_attempts"."version" > 0),
	CONSTRAINT "ai_draft_attempts_status" CHECK ("ai_draft_attempts"."status" in ('attempted', 'succeeded', 'failed', 'stale')),
	CONSTRAINT "ai_draft_attempts_priority" CHECK ("ai_draft_attempts"."priority" in ('interested', 'prewrite', 'legacy'))
);
--> statement-breakpoint
CREATE TABLE "application_parties" (
	"application_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"client_id" text COLLATE "C" NOT NULL,
	"contact_id" text COLLATE "C",
	"snapshot" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_proposals" (
	"application_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"draft_id" text COLLATE "C" NOT NULL,
	"draft_version" integer NOT NULL,
	"submission_id" text COLLATE "C",
	"snapshot" text COLLATE "C" NOT NULL,
	CONSTRAINT "application_proposals_submission_id" UNIQUE("submission_id")
);
--> statement-breakpoint
CREATE TABLE "client_contacts" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"client_id" text COLLATE "C" NOT NULL,
	"name" text COLLATE "C" NOT NULL,
	"address" text COLLATE "C" NOT NULL,
	"note" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	"archived_at" text COLLATE "C",
	"request_id" text COLLATE "C" NOT NULL,
	"request_payload" text COLLATE "C" NOT NULL,
	CONSTRAINT "client_contacts_request_id" UNIQUE("request_id"),
	CONSTRAINT "client_contacts_revision" CHECK ("client_contacts"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"name" text COLLATE "C" NOT NULL,
	"note" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	"archived_at" text COLLATE "C",
	"request_id" text COLLATE "C" NOT NULL,
	"request_payload" text COLLATE "C" NOT NULL,
	CONSTRAINT "clients_request_id" UNIQUE("request_id"),
	CONSTRAINT "clients_revision" CHECK ("clients"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_runs" (
	"local_date" text COLLATE "C" NOT NULL,
	"recipient" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" NOT NULL,
	"started_at" text COLLATE "C" NOT NULL,
	"finished_at" text COLLATE "C",
	"result" text COLLATE "C",
	CONSTRAINT "daily_runs_local_date_recipient_pk" PRIMARY KEY("local_date","recipient"),
	CONSTRAINT "daily_runs_status" CHECK ("daily_runs"."status" in ('running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "digest_outbox" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"local_date" text COLLATE "C" NOT NULL,
	"recipient" text COLLATE "C" NOT NULL,
	"snapshot" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" DEFAULT 'pending' NOT NULL,
	"created_at" text COLLATE "C" DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"attempted_at" text COLLATE "C",
	"finished_at" text COLLATE "C",
	"delivery_receipt" text COLLATE "C",
	CONSTRAINT "digest_outbox_local_date_recipient" UNIQUE("local_date","recipient"),
	CONSTRAINT "digest_outbox_status" CHECK ("digest_outbox"."status" in ('pending', 'attempted', 'sent', 'unknown')),
	CONSTRAINT "digest_outbox_sent_receipt" CHECK ("digest_outbox"."status" <> 'sent' or ("digest_outbox"."delivery_receipt" is not null and length(trim("digest_outbox"."delivery_receipt")) > 0))
);
--> statement-breakpoint
CREATE TABLE "discovery_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"settings" text COLLATE "C" NOT NULL,
	CONSTRAINT "discovery_settings_singleton" CHECK ("discovery_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "mail_content_versions" (
	"opportunity_id" text COLLATE "C" NOT NULL,
	"fingerprint" text COLLATE "C" NOT NULL,
	"job" text COLLATE "C" NOT NULL,
	CONSTRAINT "mail_content_versions_opportunity_id_fingerprint_pk" PRIMARY KEY("opportunity_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "mail_ingestion" (
	"source" text COLLATE "C" NOT NULL,
	"recipient" text COLLATE "C" NOT NULL,
	"message_id" text COLLATE "C" NOT NULL,
	"status" text COLLATE "C" NOT NULL,
	"reason" text COLLATE "C",
	"retry_pending" integer DEFAULT 0 NOT NULL,
	"checked_at" text COLLATE "C" DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "mail_ingestion_source_recipient_message_id_pk" PRIMARY KEY("source","recipient","message_id"),
	CONSTRAINT "mail_ingestion_status" CHECK ("mail_ingestion"."status" in ('processed', 'rejected', 'conflict')),
	CONSTRAINT "mail_ingestion_retry_pending" CHECK ("mail_ingestion"."retry_pending" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "mail_sync_state" (
	"source" text COLLATE "C" NOT NULL,
	"recipient" text COLLATE "C" NOT NULL,
	"state" text COLLATE "C" NOT NULL,
	CONSTRAINT "mail_sync_state_source_recipient_pk" PRIMARY KEY("source","recipient")
);
--> statement-breakpoint
CREATE TABLE "manual_application_events" (
	"application_id" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"action" text COLLATE "C" NOT NULL,
	"state" text COLLATE "C" NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "manual_application_events_application_id_revision_pk" PRIMARY KEY("application_id","revision"),
	CONSTRAINT "manual_application_events_action" CHECK ("manual_application_events"."action" in ('created', 'updated', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "manual_application_opportunities" (
	"application_id" text COLLATE "C" NOT NULL,
	"opportunity_id" text COLLATE "C" NOT NULL,
	CONSTRAINT "manual_application_opportunities_application_id_opportunity_id_pk" PRIMARY KEY("application_id","opportunity_id")
);
--> statement-breakpoint
CREATE TABLE "manual_applications" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"title" text COLLATE "C" NOT NULL,
	"contact" text COLLATE "C" NOT NULL,
	"url" text COLLATE "C",
	"applied_on" text COLLATE "C" NOT NULL,
	"stage" text COLLATE "C" NOT NULL,
	"follow_up_on" text COLLATE "C",
	"note" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	"deleted_at" text COLLATE "C",
	"request_id" text COLLATE "C" NOT NULL,
	"request_payload" text COLLATE "C" NOT NULL,
	CONSTRAINT "manual_applications_request_id" UNIQUE("request_id"),
	CONSTRAINT "manual_applications_stage" CHECK ("manual_applications"."stage" in ('applied', 'negotiating', 'won', 'closed')),
	CONSTRAINT "manual_applications_revision" CHECK ("manual_applications"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"source" text COLLATE "C" NOT NULL,
	"external_id" text COLLATE "C" NOT NULL,
	"item" text COLLATE "C" NOT NULL,
	CONSTRAINT "opportunities_source_external_id" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "opportunity_tracking" (
	"opportunity_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"state" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_draft_revisions" (
	"draft_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"body" text COLLATE "C" NOT NULL,
	"values_json" text COLLATE "C" NOT NULL,
	"missing" text COLLATE "C" NOT NULL,
	"template_snapshot" text COLLATE "C" NOT NULL,
	"request_id" text COLLATE "C" NOT NULL,
	"request_payload" text COLLATE "C" NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "proposal_draft_revisions_draft_id_version_pk" PRIMARY KEY("draft_id","version"),
	CONSTRAINT "proposal_draft_revisions_draft_request" UNIQUE("draft_id","request_id"),
	CONSTRAINT "proposal_draft_revisions_version" CHECK ("proposal_draft_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "proposal_drafts" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"title" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"source_tokens" text COLLATE "C" NOT NULL,
	"source_snapshot" text COLLATE "C" NOT NULL,
	"party" text COLLATE "C" NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	"archived_at" text COLLATE "C",
	"request_id" text COLLATE "C" NOT NULL,
	"request_payload" text COLLATE "C" NOT NULL,
	CONSTRAINT "proposal_drafts_request_id" UNIQUE("request_id"),
	CONSTRAINT "proposal_drafts_revision" CHECK ("proposal_drafts"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "proposal_revisions" (
	"opportunity_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"proposal" text COLLATE "C" NOT NULL,
	"fingerprint" text COLLATE "C" NOT NULL,
	"created_at" text COLLATE "C" DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "proposal_revisions_opportunity_id_version_pk" PRIMARY KEY("opportunity_id","version"),
	CONSTRAINT "proposal_revisions_version" CHECK ("proposal_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "proposal_templates" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"name" text COLLATE "C" NOT NULL,
	"body" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	"archived_at" text COLLATE "C",
	"request_id" text COLLATE "C" NOT NULL,
	"request_payload" text COLLATE "C" NOT NULL,
	CONSTRAINT "proposal_templates_request_id" UNIQUE("request_id"),
	CONSTRAINT "proposal_templates_revision" CHECK ("proposal_templates"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "source_receipts" (
	"source" text COLLATE "C" NOT NULL,
	"receipt_id" text COLLATE "C" NOT NULL,
	"opportunity_id" text COLLATE "C" NOT NULL,
	"received_at" text COLLATE "C" DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "source_receipts_source_receipt_id_pk" PRIMARY KEY("source","receipt_id")
);
--> statement-breakpoint
CREATE TABLE "submission_events" (
	"intent_id" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"action" text COLLATE "C" NOT NULL,
	"evidence" text COLLATE "C" NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "submission_events_intent_id_revision_pk" PRIMARY KEY("intent_id","revision")
);
--> statement-breakpoint
CREATE TABLE "submission_intents" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"draft_id" text COLLATE "C" NOT NULL,
	"draft_version" integer NOT NULL,
	"snapshot" text COLLATE "C" NOT NULL,
	"snapshot_hash" text COLLATE "C" NOT NULL,
	"approval_hash" text COLLATE "C",
	"status" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	"attempted_at" text COLLATE "C",
	"finished_at" text COLLATE "C",
	"receipt" text COLLATE "C",
	"reconciliation" text COLLATE "C",
	"request_id" text COLLATE "C" NOT NULL,
	"request_payload" text COLLATE "C" NOT NULL,
	CONSTRAINT "submission_intents_request_id" UNIQUE("request_id"),
	CONSTRAINT "submission_intents_status" CHECK ("submission_intents"."status" in ('prepared', 'approved', 'attempted', 'accepted', 'rejected', 'unknown', 'cancelled')),
	CONSTRAINT "submission_intents_revision" CHECK ("submission_intents"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "tracking_events" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "tracking_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"opportunity_id" text COLLATE "C" NOT NULL,
	"revision" integer NOT NULL,
	"state" text COLLATE "C" NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "tracking_events_opportunity_revision" UNIQUE("opportunity_id","revision")
);
--> statement-breakpoint
ALTER TABLE "source_health" ALTER COLUMN "source" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "source_health" ALTER COLUMN "status" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "source_health" ALTER COLUMN "checked_at" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "source_health" ALTER COLUMN "checked_at" SET DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS');--> statement-breakpoint
ALTER TABLE "ai_draft_attempts" ADD CONSTRAINT "ai_draft_attempts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_parties" ADD CONSTRAINT "application_parties_application_id_manual_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."manual_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_parties" ADD CONSTRAINT "application_parties_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_parties" ADD CONSTRAINT "application_parties_contact_id_client_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."client_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_proposals" ADD CONSTRAINT "application_proposals_application_id_manual_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."manual_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_proposals" ADD CONSTRAINT "application_proposals_submission_id_submission_intents_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submission_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_proposals" ADD CONSTRAINT "application_proposals_draft_version_fk" FOREIGN KEY ("draft_id","draft_version") REFERENCES "public"."proposal_draft_revisions"("draft_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_content_versions" ADD CONSTRAINT "mail_content_versions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_application_events" ADD CONSTRAINT "manual_application_events_application_id_manual_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."manual_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_application_opportunities" ADD CONSTRAINT "manual_application_opportunities_application_id_manual_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."manual_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_application_opportunities" ADD CONSTRAINT "manual_application_opportunities_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_tracking" ADD CONSTRAINT "opportunity_tracking_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_draft_revisions" ADD CONSTRAINT "proposal_draft_revisions_draft_id_proposal_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."proposal_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_revisions" ADD CONSTRAINT "proposal_revisions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_receipts" ADD CONSTRAINT "source_receipts_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_events" ADD CONSTRAINT "submission_events_intent_id_submission_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."submission_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_intents" ADD CONSTRAINT "submission_intents_draft_id_proposal_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."proposal_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_intents" ADD CONSTRAINT "submission_intents_draft_version_fk" FOREIGN KEY ("draft_id","draft_version") REFERENCES "public"."proposal_draft_revisions"("draft_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_draft_attempts_local_date" ON "ai_draft_attempts" USING btree ("local_date");--> statement-breakpoint
CREATE INDEX "application_parties_by_client" ON "application_parties" USING btree ("client_id","application_id");--> statement-breakpoint
CREATE INDEX "contacts_by_client" ON "client_contacts" USING btree ("client_id","name","id");--> statement-breakpoint
CREATE INDEX "manual_application_links" ON "manual_application_opportunities" USING btree ("opportunity_id");