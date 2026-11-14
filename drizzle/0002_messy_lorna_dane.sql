CREATE TABLE `vehicle_commands` (
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`revision` text NOT NULL,
	`vehicle_hash` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`sealed_result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `commands_vehicle_created` ON `vehicle_commands` (`vehicle_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `control_permissions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`permission_version` text NOT NULL,
	`ventilation_enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
