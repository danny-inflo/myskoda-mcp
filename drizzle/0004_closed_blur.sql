CREATE TABLE `connection_attempts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`attempts` integer NOT NULL,
	`blocked_until` integer DEFAULT 0 NOT NULL,
	`token` text,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connection_attempts_expiry` ON `connection_attempts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `connection_attempts_updated` ON `connection_attempts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `connection_gate` (
	`id` integer PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`attempts` integer NOT NULL,
	`last_token` text
);
--> statement-breakpoint
INSERT INTO `connection_gate` (`id`, `window_start`, `attempts`, `last_token`) VALUES (1, 0, 0, NULL);
--> statement-breakpoint
ALTER TABLE `vehicle_quotas` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `quotas_updated` ON `vehicle_quotas` (`updated_at`);
