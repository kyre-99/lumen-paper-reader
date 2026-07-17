CREATE TABLE `papers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`meta` text DEFAULT '' NOT NULL,
	`source_kind` text NOT NULL,
	`source_url` text,
	`object_key` text,
	`paper_text` text DEFAULT '' NOT NULL,
	`page_count` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reader_states` (
	`user_id` text PRIMARY KEY NOT NULL,
	`active_paper_id` text,
	`current_page` integer DEFAULT 1 NOT NULL,
	`zoom` real DEFAULT 0.88 NOT NULL,
	`right_open` integer DEFAULT true NOT NULL,
	`messages_json` text DEFAULT '[]' NOT NULL,
	`annotations_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);