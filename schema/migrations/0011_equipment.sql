ALTER TABLE "members" ADD COLUMN "equipment" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD COLUMN "equipment" text[] DEFAULT '{}' NOT NULL;