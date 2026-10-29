ALTER TABLE "priced_photos" ADD COLUMN "photo_height" integer;--> statement-breakpoint
ALTER TABLE "priced_photos" ADD COLUMN "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "priced_photos" ADD COLUMN "edited_by" text;--> statement-breakpoint
ALTER TABLE "priced_photos" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "priced_photos" ADD CONSTRAINT "priced_photos_edited_by_members_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;