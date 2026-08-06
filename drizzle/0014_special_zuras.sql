ALTER TABLE `paper_indexes` ADD `status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_indexes` ADD `done_count` integer DEFAULT 0 NOT NULL;