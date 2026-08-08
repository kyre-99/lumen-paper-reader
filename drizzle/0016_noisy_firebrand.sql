ALTER TABLE `paper_folders` ADD `parent_id` text REFERENCES paper_folders(id);--> statement-breakpoint
CREATE INDEX `paper_folders_user_parent_idx` ON `paper_folders` (`user_id`,`parent_id`);