ALTER TABLE `user_settings` ADD `model_provider` text DEFAULT 'OpenAI' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `model_endpoint` text DEFAULT 'https://api.openai.com/v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `model_name` text DEFAULT 'gpt-4.1-mini' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `api_key_encrypted` text DEFAULT '' NOT NULL;