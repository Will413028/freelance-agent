CREATE TABLE `ai_draft_attempts` (
	`opportunity_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`version` integer NOT NULL,
	`local_date` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text NOT NULL,
	`attempted_at` text NOT NULL,
	`finished_at` text,
	`reason` text,
	`priority` text NOT NULL,
	PRIMARY KEY(`opportunity_id`, `fingerprint`, `priority`),
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_draft_attempts_version" CHECK("ai_draft_attempts"."version" > 0),
	CONSTRAINT "ai_draft_attempts_status" CHECK("ai_draft_attempts"."status" in ('attempted', 'succeeded', 'failed', 'stale')),
	CONSTRAINT "ai_draft_attempts_priority" CHECK("ai_draft_attempts"."priority" in ('interested', 'prewrite', 'legacy'))
);
--> statement-breakpoint
CREATE INDEX `ai_draft_attempts_local_date` ON `ai_draft_attempts` (`local_date`);--> statement-breakpoint
CREATE TABLE `application_parties` (
	`application_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`contact_id` text,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `manual_applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `client_contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `application_parties_by_client` ON `application_parties` (`client_id`,`application_id`);--> statement-breakpoint
CREATE TABLE `application_proposals` (
	`application_id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`draft_version` integer NOT NULL,
	`submission_id` text,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `manual_applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `submission_intents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`,`draft_version`) REFERENCES `proposal_draft_revisions`(`draft_id`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_proposals_submission_id` ON `application_proposals` (`submission_id`);--> statement-breakpoint
CREATE TABLE `client_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`note` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`request_id` text NOT NULL,
	`request_payload` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "client_contacts_revision" CHECK("client_contacts"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_contacts_request_id` ON `client_contacts` (`request_id`);--> statement-breakpoint
CREATE INDEX `contacts_by_client` ON `client_contacts` (`client_id`,`name`,`id`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`note` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`request_id` text NOT NULL,
	`request_payload` text NOT NULL,
	CONSTRAINT "clients_revision" CHECK("clients"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_request_id` ON `clients` (`request_id`);--> statement-breakpoint
CREATE TABLE `daily_runs` (
	`local_date` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`result` text,
	PRIMARY KEY(`local_date`, `recipient`),
	CONSTRAINT "daily_runs_status" CHECK("daily_runs"."status" in ('running', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `digest_novelty` (
	`digest_id` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	PRIMARY KEY(`key`, `fingerprint`, `digest_id`),
	FOREIGN KEY (`digest_id`) REFERENCES `digest_outbox`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `digest_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`local_date` text NOT NULL,
	`recipient` text NOT NULL,
	`snapshot` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`attempted_at` text,
	`finished_at` text,
	`delivery_receipt` text,
	CONSTRAINT "digest_outbox_status" CHECK("digest_outbox"."status" in ('pending', 'attempted', 'sent', 'unknown')),
	CONSTRAINT "digest_outbox_sent_receipt" CHECK("digest_outbox"."status" <> 'sent' or ("digest_outbox"."delivery_receipt" is not null and length(trim("digest_outbox"."delivery_receipt")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_outbox_local_date_recipient` ON `digest_outbox` (`local_date`,`recipient`);--> statement-breakpoint
CREATE TABLE `discovery_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`settings` text NOT NULL,
	CONSTRAINT "discovery_settings_singleton" CHECK("discovery_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `guard` (
	`ok` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_content_versions` (
	`opportunity_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`job` text NOT NULL,
	PRIMARY KEY(`opportunity_id`, `fingerprint`),
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mail_ingestion` (
	`source` text NOT NULL,
	`recipient` text NOT NULL,
	`message_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`retry_pending` integer DEFAULT 0 NOT NULL,
	`checked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`source`, `recipient`, `message_id`),
	CONSTRAINT "mail_ingestion_status" CHECK("mail_ingestion"."status" in ('processed', 'rejected', 'conflict')),
	CONSTRAINT "mail_ingestion_retry_pending" CHECK("mail_ingestion"."retry_pending" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE `mail_sync_state` (
	`source` text NOT NULL,
	`recipient` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`source`, `recipient`)
);
--> statement-breakpoint
CREATE TABLE `manual_application_events` (
	`application_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`application_id`, `revision`),
	FOREIGN KEY (`application_id`) REFERENCES `manual_applications`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "manual_application_events_action" CHECK("manual_application_events"."action" in ('created', 'updated', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `manual_application_opportunities` (
	`application_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	PRIMARY KEY(`application_id`, `opportunity_id`),
	FOREIGN KEY (`application_id`) REFERENCES `manual_applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `manual_application_links` ON `manual_application_opportunities` (`opportunity_id`);--> statement-breakpoint
CREATE TABLE `manual_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`contact` text NOT NULL,
	`url` text,
	`applied_on` text NOT NULL,
	`stage` text NOT NULL,
	`follow_up_on` text,
	`note` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`request_id` text NOT NULL,
	`request_payload` text NOT NULL,
	CONSTRAINT "manual_applications_stage" CHECK("manual_applications"."stage" in ('applied', 'negotiating', 'won', 'closed')),
	CONSTRAINT "manual_applications_revision" CHECK("manual_applications"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_applications_request_id` ON `manual_applications` (`request_id`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`item` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opportunities_source_external_id` ON `opportunities` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `opportunity_tracking` (
	`opportunity_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `proposal_draft_revisions` (
	`draft_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`values_json` text NOT NULL,
	`missing` text NOT NULL,
	`template_snapshot` text NOT NULL,
	`request_id` text NOT NULL,
	`request_payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `version`),
	FOREIGN KEY (`draft_id`) REFERENCES `proposal_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proposal_draft_revisions_version" CHECK("proposal_draft_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_draft_revisions_draft_request` ON `proposal_draft_revisions` (`draft_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `proposal_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`revision` integer NOT NULL,
	`source_tokens` text NOT NULL,
	`source_snapshot` text NOT NULL,
	`party` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`request_id` text NOT NULL,
	`request_payload` text NOT NULL,
	CONSTRAINT "proposal_drafts_revision" CHECK("proposal_drafts"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_drafts_request_id` ON `proposal_drafts` (`request_id`);--> statement-breakpoint
CREATE TABLE `proposal_revisions` (
	`opportunity_id` text NOT NULL,
	`version` integer NOT NULL,
	`proposal` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`opportunity_id`, `version`),
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proposal_revisions_version" CHECK("proposal_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `proposal_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`request_id` text NOT NULL,
	`request_payload` text NOT NULL,
	CONSTRAINT "proposal_templates_revision" CHECK("proposal_templates"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_templates_request_id` ON `proposal_templates` (`request_id`);--> statement-breakpoint
CREATE TABLE `source_health` (
	`source` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`checked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "source_health_status" CHECK("source_health"."status" in ('not_connected', 'ok', 'failed', 'waiting'))
);
--> statement-breakpoint
CREATE TABLE `source_receipts` (
	`source` text NOT NULL,
	`receipt_id` text NOT NULL,
	`opportunity_id` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`source`, `receipt_id`),
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `submission_events` (
	`intent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`intent_id`, `revision`),
	FOREIGN KEY (`intent_id`) REFERENCES `submission_intents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `submission_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`draft_version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`approval_hash` text,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`attempted_at` text,
	`finished_at` text,
	`receipt` text,
	`reconciliation` text,
	`request_id` text NOT NULL,
	`request_payload` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `proposal_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`,`draft_version`) REFERENCES `proposal_draft_revisions`(`draft_id`,`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "submission_intents_status" CHECK("submission_intents"."status" in ('prepared', 'approved', 'attempted', 'accepted', 'rejected', 'unknown', 'cancelled')),
	CONSTRAINT "submission_intents_revision" CHECK("submission_intents"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_intents_request_id` ON `submission_intents` (`request_id`);--> statement-breakpoint
CREATE TABLE `tracking_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`opportunity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracking_events_opportunity_revision` ON `tracking_events` (`opportunity_id`,`revision`);--> statement-breakpoint
CREATE TABLE `write_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL
);
