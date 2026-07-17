CREATE TABLE `paper_states` (
	`paper_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`current_page` integer DEFAULT 1 NOT NULL,
	`zoom` real DEFAULT 0.88 NOT NULL,
	`right_open` integer DEFAULT true NOT NULL,
	`messages_json` text DEFAULT '[]' NOT NULL,
	`annotations_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`global_system_prompt` text DEFAULT '' NOT NULL,
	`inline_system_prompt` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
