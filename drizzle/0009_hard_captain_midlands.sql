ALTER TABLE `user_settings` ADD `vision_model_endpoint` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `vision_model_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `vision_api_key_encrypted` text DEFAULT '' NOT NULL;