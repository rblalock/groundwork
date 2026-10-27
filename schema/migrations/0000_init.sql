CREATE TYPE "public"."conversation_kind" AS ENUM('thread', 'job');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'running', 'failed', 'done', 'archived');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'processing', 'done', 'dead');--> statement-breakpoint
CREATE TYPE "public"."followup_kind" AS ENUM('nudge', 'morning', 'notice');--> statement-breakpoint
CREATE TYPE "public"."followup_status" AS ENUM('pending', 'sent', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'partially_paid', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."item_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."language_code" AS ENUM('en', 'es');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('user', 'assistant', 'proactive', 'system', 'reaction');--> statement-breakpoint
CREATE TYPE "public"."note_kind" AS ENUM('note', 'document');--> statement-breakpoint
CREATE TYPE "public"."owner_request_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'check', 'card', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_source" AS ENUM('manual', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."phone_status" AS ENUM('pending', 'verified', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'needs_owner', 'approved', 'sent', 'won', 'lost', 'void');--> statement-breakpoint
CREATE TYPE "public"."rule_kind" AS ENUM('pricing_modifier', 'scope', 'exclusion', 'process', 'other');--> statement-breakpoint
CREATE TYPE "public"."rule_status" AS ENUM('active', 'retired', 'suggested');--> statement-breakpoint
CREATE TYPE "public"."service_job_status" AS ENUM('open', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."stripe_account_status" AS ENUM('onboarding', 'active', 'restricted', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."unit_kind" AS ENUM('each', 'sqft', 'linear_ft', 'hour', 'visit', 'flat', 'other');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('proposed', 'scheduled', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"agent" text NOT NULL,
	"subject" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_org_id_member_id_agent_subject_pk" PRIMARY KEY("org_id","member_id","agent","subject"),
	CONSTRAINT "agent_sessions_eve_session_id_unique" UNIQUE("eve_session_id")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_revision_id" text NOT NULL,
	"member_id" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_profile" (
	"org_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"license_number" text,
	"time_zone" text DEFAULT 'America/New_York' NOT NULL,
	"quiet_start_hour" integer DEFAULT 20 NOT NULL,
	"quiet_end_hour" integer DEFAULT 7 NOT NULL,
	"quote_validity_days" integer DEFAULT 30 NOT NULL,
	"follow_up_days" integer DEFAULT 3 NOT NULL,
	"minimum_charge_cents" integer,
	"tax_rate_bp" integer,
	"language" "language_code" DEFAULT 'en' NOT NULL,
	"work_hours" jsonb DEFAULT '[{"day":1,"start":"08:00","end":"17:00"},{"day":2,"start":"08:00","end":"17:00"},{"day":3,"start":"08:00","end":"17:00"},{"day":4,"start":"08:00","end":"17:00"},{"day":5,"start":"08:00","end":"17:00"}]'::jsonb NOT NULL,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"deposit_percent" integer DEFAULT 0 NOT NULL,
	"next_invoice_number" integer DEFAULT 1 NOT NULL,
	"pdf_accent_color" text,
	"quote_footer" text,
	"invoice_footer" text,
	"pdf_hidden_details" text[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"pricebook_version" integer DEFAULT 0 NOT NULL,
	"rules_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "busy_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by_member_id" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "busy_blocks_interval" CHECK ("busy_blocks"."end_at" > "busy_blocks"."start_at")
);
--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"member_id" text,
	"eve_session_id" text NOT NULL,
	"turn_id" text,
	"kind" text NOT NULL,
	"delivery_id" text,
	"tool_name" text,
	"tool_call_id" text,
	"status" text,
	"duration_ms" integer,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"parent_id" text,
	"eve_session_id" text,
	"title" text,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"quote_id" text,
	"customer_id" text,
	"source" text,
	"email_key" text,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_eve_session_id_unique" UNIQUE("eve_session_id")
);
--> statement-breakpoint
CREATE TABLE "customer_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"member_id" text,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"phones" text[] DEFAULT '{}' NOT NULL,
	"emails" text[] DEFAULT '{}' NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_page_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page" text NOT NULL,
	"version" integer NOT NULL,
	"html" text NOT NULL,
	"request" text,
	"member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_pages" (
	"org_id" text NOT NULL,
	"page" text NOT NULL,
	"published_version" integer,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_pages_org_id_page_pk" PRIMARY KEY("org_id","page")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"phones" text[] DEFAULT '{}' NOT NULL,
	"emails" text[] DEFAULT '{}' NOT NULL,
	"language" "language_code" DEFAULT 'en' NOT NULL,
	"notes" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by_member_id" text,
	"merged_into_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"webhook_id" text,
	"kind" text NOT NULL,
	"thread_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text,
	"last_error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "email_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"address" text NOT NULL,
	"code_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"set_by_member_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"ref_id" text,
	"member_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followups" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_id" text,
	"member_id" text NOT NULL,
	"kind" "followup_kind" NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "followup_status" DEFAULT 'pending' NOT NULL,
	"sent_message_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossary_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"term" text NOT NULL,
	"spanish" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"customer_id" text,
	"property_id" text,
	"service_job_id" text,
	"quote_id" text,
	"quote_revision_id" text,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issue_date" date,
	"due_date" date,
	"lines" jsonb NOT NULL,
	"rule_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minimum_cents" integer,
	"tax_rate_bp" integer,
	"subtotal_cents" integer NOT NULL,
	"minimum_applied_cents" integer DEFAULT 0 NOT NULL,
	"adjustment_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"language" "language_code" DEFAULT 'en' NOT NULL,
	"notes" text,
	"pdf_photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pdf_url" text,
	"pay_token" text NOT NULL,
	"stripe_checkout_session_id" text,
	"created_by_member_id" text NOT NULL,
	"sent_by_member_id" text,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_pay_token_unique" UNIQUE("pay_token"),
	CONSTRAINT "invoices_amounts" CHECK ("invoices"."total_cents" >= 0 and "invoices"."amount_paid_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "login_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_phones" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"e164" text NOT NULL,
	"status" "phone_status" DEFAULT 'pending' NOT NULL,
	"photon_user_id" text,
	"assigned_line" text,
	"thread_id" text,
	"last_service" text,
	"verified_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_phones_e164_unique" UNIQUE("e164")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"role" "member_role" NOT NULL,
	"user_id" text,
	"language" "language_code" DEFAULT 'en' NOT NULL,
	"status" "member_status" DEFAULT 'active' NOT NULL,
	"work_hours" jsonb,
	"email" text,
	"email_set_by_member_id" text,
	"email_set_at" timestamp with time zone,
	"added_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text,
	"phone_e164" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"provider_message_id" text,
	"thread_id" text,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quote_id" text,
	"asks_approval" boolean DEFAULT false NOT NULL,
	"target_provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "note_kind" DEFAULT 'note' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"customer_id" text,
	"property_id" text,
	"quote_id" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"updated_by_member_id" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"suspended" boolean DEFAULT false NOT NULL,
	"suspended_at" timestamp with time zone,
	"inbox_id" text,
	"inbox_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organization_inbox_id_unique" UNIQUE("inbox_id"),
	CONSTRAINT "organization_inbox_address_unique" UNIQUE("inbox_address")
);
--> statement-breakpoint
CREATE TABLE "owner_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"requested_by_member_id" text NOT NULL,
	"status" "owner_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"invoice_id" text,
	"quote_id" text,
	"amount_cents" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"received_date" date NOT NULL,
	"reference" text,
	"source" "payment_source" DEFAULT 'manual' NOT NULL,
	"stripe_checkout_session_id" text,
	"stripe_payment_intent_id" text,
	"card_brand" text,
	"card_last4" text,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"recorded_by_member_id" text,
	"removed_at" timestamp with time zone,
	"removed_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_belongs" CHECK ("payments"."invoice_id" is not null or "payments"."quote_id" is not null),
	CONSTRAINT "payments_amount" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_refunded" CHECK ("payments"."refunded_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pricebook_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"item_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text NOT NULL,
	"member_id" text NOT NULL,
	"source_message_id" text,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricebook_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"unit_kind" "unit_kind" NOT NULL,
	"unit_label" text NOT NULL,
	"price_cents" integer NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"group" text,
	"notes" text,
	"status" "item_status" DEFAULT 'active' NOT NULL,
	"created_from_quote_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"address" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"message_id" text,
	"uploaded_by_member_id" text,
	"url" text NOT NULL,
	"name" text,
	"mime_type" text,
	"description" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_attachments_source" CHECK ("quote_attachments"."message_id" is not null or "quote_attachments"."uploaded_by_member_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "quote_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"number" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"rule_lines" jsonb NOT NULL,
	"adjustments" jsonb NOT NULL,
	"rule_ids" text[] DEFAULT '{}' NOT NULL,
	"state" text NOT NULL,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"lines_subtotal_cents" integer NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"minimum_applied_cents" integer NOT NULL,
	"adjustment_cents" integer NOT NULL,
	"pre_tax_cents" integer NOT NULL,
	"taxable_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"tax_rate_bp" integer,
	"pricebook_version" integer NOT NULL,
	"rules_version" integer NOT NULL,
	"profile_version" integer NOT NULL,
	"calc_hash" text NOT NULL,
	"pdf_url" text,
	"valid_until" date NOT NULL,
	"customer_language" "language_code" NOT NULL,
	"customer_notes" text,
	"private_notes" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"customer_id" text,
	"property_id" text,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"current_revision_id" text,
	"created_by_member_id" text NOT NULL,
	"thread_session_id" text,
	"approved_at" timestamp with time zone,
	"approved_by_member_id" text,
	"outcome_at" timestamp with time zone,
	"customer_token" text,
	"customer_approved_at" timestamp with time zone,
	"customer_approved_name" text,
	"customer_approved_revision_id" text,
	"deposit_cents" integer,
	"stripe_checkout_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_customer_token_unique" UNIQUE("customer_token"),
	CONSTRAINT "quotes_deposit" CHECK ("quotes"."deposit_cents" is null or "quotes"."deposit_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"text" text NOT NULL,
	"kind" "rule_kind" NOT NULL,
	"effect" jsonb,
	"status" "rule_status" DEFAULT 'active' NOT NULL,
	"member_id" text NOT NULL,
	"source_message_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "service_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"customer_id" text,
	"property_id" text,
	"quote_id" text,
	"quote_revision_id" text,
	"status" "service_job_status" DEFAULT 'open' NOT NULL,
	"notes" text,
	"created_by_member_id" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "stripe_accounts" (
	"org_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"status" "stripe_account_status" DEFAULT 'onboarding' NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"connected_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_accounts_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"language" "language_code" NOT NULL,
	"glossary_hash" text NOT NULL,
	"source_language" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"member_id" text,
	"channel" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_output_tokens" integer NOT NULL,
	"eve_session_id" text,
	"turn_id" text,
	"lease_until" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_limits" (
	"org_id" text PRIMARY KEY NOT NULL,
	"hourly_turns" integer,
	"hourly_output_tokens" integer,
	"concurrent_turns" integer,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"event_key" text NOT NULL,
	"member_id" text,
	"conversation_id" text,
	"eve_session_id" text,
	"turn_id" text,
	"step_index" integer,
	"reservation_id" text,
	"channel" text NOT NULL,
	"kind" text DEFAULT 'step' NOT NULL,
	"deployment" text NOT NULL,
	"response_model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer,
	"estimated_cost_usd" numeric(14, 8) DEFAULT 0 NOT NULL,
	"price_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_crew" (
	"org_id" text NOT NULL,
	"visit_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "visit_crew_visit_id_member_id_pk" PRIMARY KEY("visit_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "visit_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"visit_id" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"snapshot" jsonb NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"job_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"status" "visit_status" DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_member_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visits_interval" CHECK ("visits"."end_at" > "visits"."start_at"),
	CONSTRAINT "visits_buffers" CHECK ("visits"."buffer_before_minutes" between 0 and 480 and "visits"."buffer_after_minutes" between 0 and 480)
);
--> statement-breakpoint
CREATE TABLE "work_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"job_id" text NOT NULL,
	"visit_id" text,
	"message_id" text,
	"added_by_member_id" text NOT NULL,
	"url" text NOT NULL,
	"name" text,
	"mime_type" text,
	"description" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_quote_revision_id_quote_revisions_id_fk" FOREIGN KEY ("quote_revision_id") REFERENCES "public"."quote_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profile" ADD CONSTRAINT "business_profile_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "busy_blocks" ADD CONSTRAINT "busy_blocks_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "busy_blocks" ADD CONSTRAINT "busy_blocks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "busy_blocks" ADD CONSTRAINT "busy_blocks_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_changes" ADD CONSTRAINT "customer_changes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_changes" ADD CONSTRAINT "customer_changes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_changes" ADD CONSTRAINT "customer_changes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_page_versions" ADD CONSTRAINT "customer_page_versions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_page_versions" ADD CONSTRAINT "customer_page_versions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_pages" ADD CONSTRAINT "customer_pages_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_archived_by_member_id_members_id_fk" FOREIGN KEY ("archived_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merged_into_id_customers_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_claims" ADD CONSTRAINT "email_claims_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_claims" ADD CONSTRAINT "email_claims_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_claims" ADD CONSTRAINT "email_claims_set_by_member_id_members_id_fk" FOREIGN KEY ("set_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followups" ADD CONSTRAINT "followups_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_updated_by_member_id_members_id_fk" FOREIGN KEY ("updated_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_job_id_service_jobs_id_fk" FOREIGN KEY ("service_job_id") REFERENCES "public"."service_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_revision_id_quote_revisions_id_fk" FOREIGN KEY ("quote_revision_id") REFERENCES "public"."quote_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sent_by_member_id_members_id_fk" FOREIGN KEY ("sent_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_codes" ADD CONSTRAINT "login_codes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_codes" ADD CONSTRAINT "login_codes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_phones" ADD CONSTRAINT "member_phones_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_phones" ADD CONSTRAINT "member_phones_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_email_set_by_member_id_members_id_fk" FOREIGN KEY ("email_set_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_updated_by_member_id_members_id_fk" FOREIGN KEY ("updated_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_requests" ADD CONSTRAINT "owner_requests_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_requests" ADD CONSTRAINT "owner_requests_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_requests" ADD CONSTRAINT "owner_requests_requested_by_member_id_members_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_member_id_members_id_fk" FOREIGN KEY ("recorded_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_removed_by_member_id_members_id_fk" FOREIGN KEY ("removed_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_changes" ADD CONSTRAINT "pricebook_changes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_changes" ADD CONSTRAINT "pricebook_changes_item_id_pricebook_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pricebook_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_changes" ADD CONSTRAINT "pricebook_changes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD CONSTRAINT "pricebook_items_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_attachments" ADD CONSTRAINT "quote_attachments_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_attachments" ADD CONSTRAINT "quote_attachments_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_attachments" ADD CONSTRAINT "quote_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_attachments" ADD CONSTRAINT "quote_attachments_uploaded_by_member_id_members_id_fk" FOREIGN KEY ("uploaded_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approved_by_member_id_members_id_fk" FOREIGN KEY ("approved_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_quote_revision_id_quote_revisions_id_fk" FOREIGN KEY ("quote_revision_id") REFERENCES "public"."quote_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD CONSTRAINT "stripe_accounts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD CONSTRAINT "stripe_accounts_connected_by_member_id_members_id_fk" FOREIGN KEY ("connected_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_reservations" ADD CONSTRAINT "turn_reservations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_reservations" ADD CONSTRAINT "turn_reservations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_limits" ADD CONSTRAINT "usage_limits_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_receipts" ADD CONSTRAINT "usage_receipts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_crew" ADD CONSTRAINT "visit_crew_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_crew" ADD CONSTRAINT "visit_crew_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_crew" ADD CONSTRAINT "visit_crew_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_revisions" ADD CONSTRAINT "visit_revisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_revisions" ADD CONSTRAINT "visit_revisions_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_revisions" ADD CONSTRAINT "visit_revisions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_job_id_service_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_photos" ADD CONSTRAINT "work_photos_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_photos" ADD CONSTRAINT "work_photos_job_id_service_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_photos" ADD CONSTRAINT "work_photos_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_photos" ADD CONSTRAINT "work_photos_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_photos" ADD CONSTRAINT "work_photos_added_by_member_id_members_id_fk" FOREIGN KEY ("added_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_idx" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "busy_blocks_org_start_idx" ON "busy_blocks" USING btree ("org_id","start_at");--> statement-breakpoint
CREATE INDEX "conversation_events_org_conversation_idx" ON "conversation_events" USING btree ("org_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_events_org_created_idx" ON "conversation_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_events_org_delivery_idx" ON "conversation_events" USING btree ("org_id","delivery_id");--> statement-breakpoint
CREATE INDEX "conversation_events_org_call_idx" ON "conversation_events" USING btree ("org_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_member_thread_idx" ON "conversations" USING btree ("org_id","member_id") WHERE "conversations"."kind" = 'thread';--> statement-breakpoint
CREATE INDEX "conversations_org_parent_idx" ON "conversations" USING btree ("org_id","parent_id");--> statement-breakpoint
CREATE INDEX "conversations_org_member_kind_idx" ON "conversations" USING btree ("org_id","member_id","kind");--> statement-breakpoint
CREATE INDEX "conversations_org_quote_idx" ON "conversations" USING btree ("org_id","quote_id");--> statement-breakpoint
CREATE INDEX "conversations_org_customer_idx" ON "conversations" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "conversations_org_member_email_idx" ON "conversations" USING btree ("org_id","member_id","email_key");--> statement-breakpoint
CREATE INDEX "customer_changes_org_customer_idx" ON "customer_changes" USING btree ("org_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_contacts_org_customer_idx" ON "customer_contacts" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contacts_preferred_idx" ON "customer_contacts" USING btree ("org_id","customer_id") WHERE "customer_contacts"."preferred";--> statement-breakpoint
CREATE UNIQUE INDEX "customer_page_versions_org_page_version_idx" ON "customer_page_versions" USING btree ("org_id","page","version");--> statement-breakpoint
CREATE INDEX "customers_org_idx" ON "customers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "deliveries_org_member_status_idx" ON "deliveries" USING btree ("org_id","member_id","status","sent_at");--> statement-breakpoint
CREATE INDEX "deliveries_status_next_idx" ON "deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_claims_member_pending_idx" ON "email_claims" USING btree ("org_id","member_id") WHERE "email_claims"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "email_claims_org_address_idx" ON "email_claims" USING btree ("org_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_key_idx" ON "events" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "followups_org_due_idx" ON "followups" USING btree ("org_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "glossary_terms_org_term_idx" ON "glossary_terms" USING btree ("org_id",lower("term"));--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_number_idx" ON "invoices" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "invoices_org_status_idx" ON "invoices" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "invoices_org_customer_idx" ON "invoices" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_job_idx" ON "invoices" USING btree ("org_id","service_job_id") WHERE "invoices"."service_job_id" is not null and "invoices"."status" <> 'void';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_quote_idx" ON "invoices" USING btree ("org_id","quote_id") WHERE "invoices"."quote_id" is not null and "invoices"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "login_codes_phone_created_idx" ON "login_codes" USING btree ("phone_e164","created_at");--> statement-breakpoint
CREATE INDEX "members_org_idx" ON "members" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_org_user_idx" ON "members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_org_email_idx" ON "members" USING btree ("org_id",lower("email")) WHERE "members"."email" is not null;--> statement-breakpoint
CREATE INDEX "messages_member_created_idx" ON "messages" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "notes_org_updated_idx" ON "notes" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "notes_org_customer_idx" ON "notes" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "notes_org_property_idx" ON "notes" USING btree ("org_id","property_id");--> statement-breakpoint
CREATE INDEX "payments_org_invoice_idx" ON "payments" USING btree ("org_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payments_org_quote_idx" ON "payments" USING btree ("org_id","quote_id");--> statement-breakpoint
CREATE INDEX "payments_org_created_idx" ON "payments" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_stripe_session_idx" ON "payments" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricebook_items_org_name_key_idx" ON "pricebook_items" USING btree ("org_id","name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_revisions_quote_number_idx" ON "quote_revisions" USING btree ("quote_id","number");--> statement-breakpoint
CREATE INDEX "quotes_org_updated_idx" ON "quotes" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "rules_org_idx" ON "rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "service_jobs_org_status_idx" ON "service_jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "service_jobs_org_customer_idx" ON "service_jobs" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_jobs_org_quote_idx" ON "service_jobs" USING btree ("org_id","quote_id") WHERE "service_jobs"."quote_id" is not null and "service_jobs"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stripe_events_org_idx" ON "stripe_events" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_org_key_idx" ON "translations" USING btree ("org_id","source_hash","language","glossary_hash");--> statement-breakpoint
CREATE INDEX "translations_org_created_idx" ON "translations" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "turn_reservations_org_created_idx" ON "turn_reservations" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "turn_reservations_org_status_idx" ON "turn_reservations" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "turn_reservations_org_key_idx" ON "turn_reservations" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_receipts_org_event_idx" ON "usage_receipts" USING btree ("org_id","event_key");--> statement-breakpoint
CREATE INDEX "usage_receipts_org_created_idx" ON "usage_receipts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_receipts_org_reservation_idx" ON "usage_receipts" USING btree ("org_id","reservation_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "visit_crew_org_member_idx" ON "visit_crew" USING btree ("org_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_revisions_visit_revision_idx" ON "visit_revisions" USING btree ("org_id","visit_id","revision");--> statement-breakpoint
CREATE INDEX "visits_org_start_idx" ON "visits" USING btree ("org_id","start_at");--> statement-breakpoint
CREATE INDEX "visits_org_job_idx" ON "visits" USING btree ("org_id","job_id");--> statement-breakpoint
CREATE INDEX "work_photos_org_job_idx" ON "work_photos" USING btree ("org_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_photos_message_url_idx" ON "work_photos" USING btree ("org_id","message_id","url") WHERE "work_photos"."message_id" is not null;--> statement-breakpoint
-- A phone or email written straight to "customers" is filed under that customer's preferred contact, or
-- a new one named after the customer when it has none. Values a contact already holds are left alone,
-- so the app's own writes to the mirror change nothing here.
CREATE FUNCTION "customer_contacts_from_mirror"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_phones text[];
  new_emails text[];
  target text;
BEGIN
  SELECT coalesce(array_agg(s.v ORDER BY s.ord), '{}') INTO new_phones
  FROM (
    SELECT u.v, min(u.ord) AS ord FROM unnest(NEW."phones") WITH ORDINALITY AS u(v, ord)
    WHERE NOT EXISTS (
      SELECT 1 FROM "customer_contacts" cc
      WHERE cc."org_id" = NEW."org_id" AND cc."customer_id" = NEW."id" AND u.v = ANY (cc."phones")
    )
    GROUP BY u.v
  ) s;
  SELECT coalesce(array_agg(s.v ORDER BY s.ord), '{}') INTO new_emails
  FROM (
    SELECT u.v, min(u.ord) AS ord FROM unnest(NEW."emails") WITH ORDINALITY AS u(v, ord)
    WHERE NOT EXISTS (
      SELECT 1 FROM "customer_contacts" cc
      WHERE cc."org_id" = NEW."org_id" AND cc."customer_id" = NEW."id" AND u.v = ANY (cc."emails")
    )
    GROUP BY u.v
  ) s;
  IF cardinality(new_phones) = 0 AND cardinality(new_emails) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT cc."id" INTO target FROM "customer_contacts" cc
  WHERE cc."org_id" = NEW."org_id" AND cc."customer_id" = NEW."id"
  ORDER BY cc."preferred" DESC, cc."created_at", cc."id"
  LIMIT 1;
  IF target IS NULL THEN
    INSERT INTO "customer_contacts" ("id", "org_id", "customer_id", "name", "phones", "emails", "preferred")
    VALUES ('cont_' || substr(md5(random()::text || clock_timestamp()::text), 1, 16), NEW."org_id", NEW."id", NEW."name", new_phones, new_emails, true);
  ELSE
    UPDATE "customer_contacts"
    SET "phones" = "phones" || new_phones, "emails" = "emails" || new_emails, "updated_at" = now()
    WHERE "id" = target;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "customers_mirror_to_contacts"
AFTER INSERT OR UPDATE OF "phones", "emails" ON "customers"
FOR EACH ROW EXECUTE FUNCTION "customer_contacts_from_mirror"();
