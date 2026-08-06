CREATE TABLE `paper_chunks` (
	`paper_id` text NOT NULL,
	`chunk_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`page` integer DEFAULT 1 NOT NULL,
	`vector` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`paper_id`, `chunk_id`),
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `paper_chunks_user_id_idx` ON `paper_chunks` (`user_id`);--> statement-breakpoint
CREATE TABLE `paper_indexes` (
	`paper_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`embedding_model` text DEFAULT '' NOT NULL,
	`text_stamp` text DEFAULT '' NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`paper_id`) REFERENCES `papers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `paper_indexes_user_id_idx` ON `paper_indexes` (`user_id`);--> statement-breakpoint
ALTER TABLE `user_settings` ADD `embedding_model_endpoint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `embedding_model_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `embedding_api_key_encrypted` text DEFAULT '' NOT NULL;