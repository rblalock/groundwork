ALTER TABLE "business_profile" ADD COLUMN "late_after_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "day_end_grace_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "lead_minutes" integer DEFAULT 45 NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "delay_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_delay" CHECK ("visits"."delay_minutes" between 0 and 480);