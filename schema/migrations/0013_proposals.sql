CREATE TYPE "public"."proposal_kind" AS ENUM('move_stops');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('open', 'applied', 'dropped', 'expired');--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"member_id" text NOT NULL,
	"date" date NOT NULL,
	"reason" text NOT NULL,
	"items" jsonb NOT NULL,
	"status" "proposal_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_member_id" text,
	"applied_item_ids" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_member_id_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_org_status_idx" ON "proposals" USING btree ("org_id","status","date");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_open_member_day_idx" ON "proposals" USING btree ("org_id","kind","member_id","date") WHERE "proposals"."status" = 'open';