ALTER TYPE "public"."proposal_kind" ADD VALUE 'move_weather';--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_business_day_idx" ON "proposals" USING btree ("org_id","kind","date") WHERE "proposals"."member_id" is null;