CREATE TABLE `study_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`study_date` text NOT NULL,
	`minutes` integer NOT NULL,
	`topic` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_study_sessions_user_date` ON `study_sessions` (`user_id`,`study_date`);