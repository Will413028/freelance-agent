CREATE TABLE `__new_daily_runs` (
	`local_date` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`result` text,
	CONSTRAINT "daily_runs_status" CHECK("__new_daily_runs"."status" in ('running', 'complete', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_daily_runs`("local_date", "status", "started_at", "finished_at", "result") SELECT "local_date", "status", "started_at", "finished_at", "result" FROM `daily_runs`;--> statement-breakpoint
DROP TABLE `daily_runs`;--> statement-breakpoint
ALTER TABLE `__new_daily_runs` RENAME TO `daily_runs`;
