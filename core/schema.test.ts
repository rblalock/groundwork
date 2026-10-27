import { test } from "node:test";
import assert from "node:assert/strict";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/schema";
import type { UnitKind } from "../schema/types";

// Compile-time: the unit_kind enum and UnitKind must list the same values.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const unitKindsMatch: Same<(typeof schema.unitKind.enumValues)[number], UnitKind> = true;

test("schema defines the 50 tables", () => {
  assert.ok(unitKindsMatch);
  const names = Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableConfig(t as PgTable).name)
    .sort();
  assert.deepEqual(names, [
    "account", "agent_sessions", "approvals", "business_profile", "busy_blocks", "conversation_events", "conversations", "customer_changes", "customer_contacts", "customer_page_versions", "customer_pages", "customers", "deliveries", "email_claims", "events",
    "followups", "glossary_terms", "invitation", "invoices", "login_codes", "member", "member_phones", "members", "messages",
    "notes", "organization", "owner_requests", "payments", "pricebook_changes", "pricebook_items", "properties",
    "quote_attachments", "quote_revisions", "quotes", "rate_limit", "rules", "service_jobs", "session",
    "stripe_accounts", "stripe_events", "translations", "turn_reservations", "usage_limits", "usage_receipts", "user", "verification", "visit_crew",
    "visit_revisions", "visits", "work_photos",
  ]);
});
