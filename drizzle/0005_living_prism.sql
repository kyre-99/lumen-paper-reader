ALTER TABLE `user_settings` ADD `sync_endpoint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `sync_username` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `sync_password_encrypted` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `sync_remote_path` text DEFAULT 'lumen-backup' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `sync_last_backup_at` text;