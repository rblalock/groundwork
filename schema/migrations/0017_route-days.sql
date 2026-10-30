ALTER TYPE "public"."proposal_kind" ADD VALUE 'route_days';--> statement-breakpoint
DROP INDEX "proposals_business_day_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_business_day_idx" ON "proposals" USING btree ("org_id","kind","date") WHERE "proposals"."member_id" is null and "proposals"."kind" = 'move_weather';