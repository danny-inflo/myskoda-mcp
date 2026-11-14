CREATE TABLE `login_attempts` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_expiry` ON `login_attempts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `web_sessions_expiry` ON `web_sessions` (`expires_at`);