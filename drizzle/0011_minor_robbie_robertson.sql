CREATE INDEX `llm_usage_user_id_idx` ON `llm_usage` (`user_id`);--> statement-breakpoint
CREATE INDEX `paper_folders_user_id_idx` ON `paper_folders` (`user_id`);--> statement-breakpoint
CREATE INDEX `papers_user_id_idx` ON `papers` (`user_id`);--> statement-breakpoint
CREATE INDEX `reading_sessions_user_paper_day_idx` ON `reading_sessions` (`user_id`,`paper_id`,`day`);