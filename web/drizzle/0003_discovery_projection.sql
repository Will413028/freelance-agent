CREATE TABLE `discovery_items` (
	`opportunity_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`review_status` text,
	`novelty` text NOT NULL,
	`deadline_at` text,
	`published_at` text,
	`settings_revision` integer NOT NULL,
	`excluded` integer NOT NULL,
	`base_tenths` integer NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "discovery_items_excluded" CHECK("discovery_items"."excluded" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE `discovery_versions` (
	`opportunity_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`deadline_at` text,
	`published_at` text,
	`settings_revision` integer NOT NULL,
	`excluded` integer NOT NULL,
	`base_tenths` integer NOT NULL,
	PRIMARY KEY(`opportunity_id`, `fingerprint`),
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "discovery_versions_excluded" CHECK("discovery_versions"."excluded" in (0, 1))
);
