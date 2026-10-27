CREATE TABLE "priced_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text NOT NULL,
	"url" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"regions" jsonb NOT NULL,
	"member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD COLUMN "photo_prompt" text;--> statement-breakpoint
ALTER TABLE "priced_photos" ADD CONSTRAINT "priced_photos_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priced_photos" ADD CONSTRAINT "priced_photos_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priced_photos" ADD CONSTRAINT "priced_photos_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "priced_photos_org_quote_source_idx" ON "priced_photos" USING btree ("org_id","quote_id","source_url");