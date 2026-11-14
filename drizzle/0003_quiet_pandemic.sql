ALTER TABLE `vehicle_commands` ADD `input_fingerprint` text;--> statement-breakpoint
ALTER TABLE `control_permissions` ADD `charging_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `control_permissions` ADD `air_conditioning_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `control_permissions` ADD `auxiliary_heating_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `control_permissions` ADD `sealed_spin` text;