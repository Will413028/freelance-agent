CREATE TABLE `writer_lease` (
	`id` integer PRIMARY KEY NOT NULL,
	`holder` text,
	`token` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "writer_lease_singleton" CHECK("writer_lease"."id" = 1)
);
