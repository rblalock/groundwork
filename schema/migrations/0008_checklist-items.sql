CREATE TABLE "checklist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"job_id" text NOT NULL,
	"line_index" integer NOT NULL,
	"name" text NOT NULL,
	"quantity" numeric NOT NULL,
	"unit_label" text NOT NULL,
	"located" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"done_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_job_id_service_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_done_by_member_id_members_id_fk" FOREIGN KEY ("done_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_items_org_job_line_idx" ON "checklist_items" USING btree ("org_id","job_id","line_index");