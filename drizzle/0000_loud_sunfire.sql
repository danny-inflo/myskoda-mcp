CREATE TABLE `vehicle_cache` (
	`user_id` text NOT NULL,
	`section` text NOT NULL,
	`revision` text NOT NULL,
	`sealed` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `section`)
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`revision` text NOT NULL,
	`key_expires_at` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_leases` (
	`vehicle_hash` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vehicle_quotas` (
	`vehicle_hash` text PRIMARY KEY NOT NULL,
	`remaining` integer,
	`quota_limit` integer,
	`reset_at` integer,
	`blocked_until` integer DEFAULT 0 NOT NULL
);
