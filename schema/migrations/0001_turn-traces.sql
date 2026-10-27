CREATE TABLE "turn_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"conversation_id" text,
	"member_id" text,
	"eve_session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"source" text NOT NULL,
	"model_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_traces" ADD CONSTRAINT "turn_traces_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_traces" ADD CONSTRAINT "turn_traces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_traces" ADD CONSTRAINT "turn_traces_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_traces_org_session_turn_idx" ON "turn_traces" USING btree ("org_id","eve_session_id","turn_id");--> statement-breakpoint
CREATE INDEX "turn_traces_org_conversation_idx" ON "turn_traces" USING btree ("org_id","conversation_id","started_at");