import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  Adjustment,
  DeliveryProgress,
  InboundAttachment,
  InvoiceLine,
  LineResult,
  NoteFile,
  PricedCandidate,
  PricedRegion,
  RuleEffect,
  RuleLine,
  TraceStep,
  TraceUsage,
  WorkingInterval,
} from "./types";

// Money is integer cents, percentages are basis points, and calendar dates are
// `YYYY-MM-DD` strings, so nothing shifts with the server's time zone.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const memberStatus = pgEnum("member_status", ["active", "removed"]);
export const phoneStatus = pgEnum("phone_status", ["pending", "verified", "stopped"]);
export const unitKind = pgEnum("unit_kind", [
  "each",
  "sqft",
  "linear_ft",
  "hour",
  "visit",
  "flat",
  "other",
]);
export const itemStatus = pgEnum("item_status", ["active", "retired"]);
export const ruleKind = pgEnum("rule_kind", [
  "pricing_modifier",
  "scope",
  "exclusion",
  "process",
  "other",
]);
export const ruleStatus = pgEnum("rule_status", ["active", "retired", "suggested"]);
export const quoteStatus = pgEnum("quote_status", [
  "draft",
  "needs_owner",
  "approved",
  "sent",
  "won",
  "lost",
  "void",
]);
export const messageDirection = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageKind = pgEnum("message_kind", [
  "user",
  "assistant",
  "proactive",
  "system",
  "reaction",
]);
/** `notice`: a proactive notice (a crew draft, an approval) that quiet hours held back. */
export const followupKind = pgEnum("followup_kind", ["nudge", "morning", "notice"]);
export const followupStatus = pgEnum("followup_status", ["pending", "sent", "done", "cancelled"]);
export const ownerRequestStatus = pgEnum("owner_request_status", [
  "pending",
  "approved",
  "declined",
]);
export const languageCode = pgEnum("language_code", ["en", "es"]);
export const conversationKind = pgEnum("conversation_kind", ["thread", "job"]);
/**
 * `active` is open and idle; `running` while a turn the thread handed it is under way; `failed` when that
 * turn failed (the job stays open); `done` when the work is finished; `archived` when it's put away.
 */
export const conversationStatus = pgEnum("conversation_status", ["active", "running", "failed", "done", "archived"]);
/** A service job is the work itself (from a won quote, or on its own): open until it's completed or cancelled. */
export const serviceJobStatus = pgEnum("service_job_status", ["open", "completed", "cancelled"]);
/** `proposed` is pencilled in and still holds the time; `scheduled` is booked. */
export const visitStatus = pgEnum("visit_status", ["proposed", "scheduled", "completed", "cancelled"]);
/**
 * `draft` until it's issued (lines editable); `sent` once issued, with its lines frozen; then
 * `partially_paid` and `paid` as payments come in. `void` only with no payments on it.
 */
export const invoiceStatus = pgEnum("invoice_status", ["draft", "sent", "partially_paid", "paid", "void"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "check", "card", "other"]);
/** `manual`: a member recorded it. `stripe`: the customer paid the invoice's pay link. */
export const paymentSource = pgEnum("payment_source", ["manual", "stripe"]);
/**
 * A business's Stripe account: `onboarding` until Stripe lets it take payments, `active` when it can,
 * `restricted` when Stripe wants more details, `disconnected` once unlinked here or from Stripe.
 */
export const stripeAccountStatus = pgEnum("stripe_account_status", ["onboarding", "active", "restricted", "disconnected"]);

/** A business note is text; a document is a file a member kept, with its description. */
export const noteKind = pgEnum("note_kind", ["note", "document"]);

/**
 * An inbound text's place in the queue: `pending` until a worker leases it, `processing` while one
 * holds it, `done` once handled (handed to eve, answered with a fixed line, or ignored), `dead` after
 * its last failed try.
 */
export const deliveryStatus = pgEnum("delivery_status", ["pending", "processing", "done", "dead"]);

/** Monday to Friday, 8 to 5: the hours a new business starts with until the owner says otherwise. */
export const DEFAULT_WORK_HOURS: WorkingInterval[] = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "17:00" }));

/**
 * A business: the tenant every other table belongs to. Shaped like Better Auth's organization
 * plugin table, so the web app's auth can adopt it. `metadata` is a JSON string, as Better Auth stores it.
 */
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /**
   * The business's logo: the stored URL of the normalized PNG or JPEG (`core/branding.ts`), printed on
   * its quote and invoice PDFs and shown in the web app and on its pay page. Null for none.
   */
  logo: text("logo"),
  metadata: text("metadata"),
  /**
   * Paused by a super admin: its members' texts start no turns, the web app shows a paused screen, and
   * nothing texts its members. Payments still record.
   */
  suspended: boolean("suspended").notNull().default(false),
  suspendedAt: timestamptz("suspended_at"),
  /**
   * The business's AgentMail inbox, where members forward emails to the assistant (core/email-intake.ts).
   * Unique: a forwarded email finds its business by the inbox it arrived in. Null until a super admin makes one.
   */
  inboxId: text("inbox_id").unique(),
  inboxAddress: text("inbox_address").unique(),
  createdAt: createdAt(),
});

/**
 * Better Auth: someone who can sign in to the web app. A member gets one on their first sign-in by a
 * texted code (`members.user_id` links it); super admins sign up with email and password. Phone users
 * get a placeholder email, since Better Auth requires one.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** `super_admin` for us, who see every business. Null for everyone else: their role is per business, on `members`. */
  role: text("role"),
  createdAt: createdAt(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** Better Auth sessions. `active_organization_id` is the business the web app shows. */
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamptz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

/** Better Auth credentials: a super admin's password. Phone sign-in has none. */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/** Better Auth's per-IP rate limits, in the database so every serverless instance shares them. */
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/**
 * Better Auth's organization-plugin tables. Required by the plugin and unused: who belongs to which
 * business, and as what, is `members` (with `members.user_id`), which the texting assistant already
 * keeps. Self-serve invites could use `invitation` later.
 */
export const authMember = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("member_org_user_idx").on(t.organizationId, t.userId)],
);

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamptz("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

/** The business that owns a row. Every query on a business table filters by it. */
const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organization.id);

/** One row per org. The version counters invalidate stale quotes. */
export const businessProfile = pgTable("business_profile", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  licenseNumber: text("license_number"),
  timeZone: text("time_zone").notNull().default("America/New_York"),
  quietStartHour: integer("quiet_start_hour").notNull().default(20),
  quietEndHour: integer("quiet_end_hour").notNull().default(7),
  quoteValidityDays: integer("quote_validity_days").notNull().default(30),
  followUpDays: integer("follow_up_days").notNull().default(3),
  minimumChargeCents: integer("minimum_charge_cents"),
  taxRateBp: integer("tax_rate_bp"),
  language: languageCode("language").notNull().default("en"),
  /** When the crew work, in `timeZone`: what visits are booked into unless a member has their own hours. */
  workHours: jsonb("work_hours").$type<WorkingInterval[]>().notNull().default(DEFAULT_WORK_HOURS),
  /** Days from an invoice's issue date to its due date. 0 is due on receipt. */
  paymentTermsDays: integer("payment_terms_days").notNull().default(0),
  /** The share of a quote's total asked as a deposit when the customer approves it online, 0 to 100. 0 asks none. */
  depositPercent: integer("deposit_percent").notNull().default(0),
  /**
   * Whether customers see each line's price. Off, the quote link, its PDF, and its priced photo show each
   * line's scope (name and quantity) and only the totals, and so does its invoice PDF; the business still sees every price.
   */
  customerLinePrices: boolean("customer_line_prices").notNull().default(true),
  /** The number the business's next invoice gets (INV-0001 is 1). Taken under the row's lock, so two can't share one. */
  nextInvoiceNumber: integer("next_invoice_number").notNull().default(1),
  /**
   * How the business's PDFs look (`core/branding.ts`). Null and empty are today's look: no accent,
   * the standard closing lines, and every contact fact the profile has. `pdfAccentColor` is `#rrggbb`;
   * `pdfHiddenDetails` lists the facts left off (`address`, `phone`, `email`, `licenseNumber`).
   */
  pdfAccentColor: text("pdf_accent_color"),
  quoteFooter: text("quote_footer"),
  invoiceFooter: text("invoice_footer"),
  pdfHiddenDetails: text("pdf_hidden_details").array().notNull().default([]),
  version: integer("version").notNull().default(1),
  pricebookVersion: integer("pricebook_version").notNull().default(0),
  rulesVersion: integer("rules_version").notNull().default(0),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    role: memberRole("role").notNull(),
    /** The member's web login, set on their first sign-in. Null for someone who only texts. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    language: languageCode("language").notNull().default("en"),
    status: memberStatus("status").notNull().default("active"),
    /** This member's own working hours; null works the business's (`business_profile.work_hours`). */
    workHours: jsonb("work_hours").$type<WorkingInterval[]>(),
    /**
     * The address this member forwards emails from, lowercase, once proven theirs (`email_claims`). An
     * email to the business's inbox is theirs only when it comes from this address and its sender verifies;
     * one member per address in a business. Who asked for it (themself, or someone above them) and when it
     * was confirmed.
     */
    email: text("email"),
    emailSetByMemberId: text("email_set_by_member_id").references((): AnyPgColumn => members.id),
    emailSetAt: timestamptz("email_set_at"),
    /** Null for the owner seeded at setup. */
    addedByMemberId: text("added_by_member_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("members_org_idx").on(t.orgId),
    uniqueIndex("members_org_user_idx").on(t.orgId, t.userId),
    uniqueIndex("members_org_email_idx").on(t.orgId, sql`lower(${t.email})`).where(sql`${t.email} is not null`),
  ],
);

/**
 * An address someone asked to use as a member's forwarding email, not yet proven theirs. It turns into
 * `members.email` only when an email that verifies as sent from it (core/email-auth.ts), to the
 * business's inbox, carries the code (`core/email-claims.ts`). Only the code's keyed hash is stored.
 * One `pending` claim per member; a wrong code counts in `attempts`, and the claim locks after a few.
 * `pending` until it's `confirmed`, `cancelled` (replaced or cleared), or `locked`; past `expires_at` it's dead.
 */
export const emailClaims = pgTable(
  "email_claims",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    /** Lowercase. */
    address: text("address").notNull(),
    codeHash: text("code_hash").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    setByMemberId: text("set_by_member_id")
      .notNull()
      .references(() => members.id),
    expiresAt: timestamptz("expires_at").notNull(),
    confirmedAt: timestamptz("confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_claims_member_pending_idx").on(t.orgId, t.memberId).where(sql`${t.status} = 'pending'`),
    index("email_claims_org_address_idx").on(t.orgId, t.address),
  ],
);

/** `e164` is unique across businesses: an inbound text finds its business by the sender's phone. */
export const memberPhones = pgTable("member_phones", {
  id: text("id").primaryKey(),
  orgId: orgId(),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id),
  e164: text("e164").notNull().unique(),
  status: phoneStatus("status").notNull().default("pending"),
  photonUserId: text("photon_user_id"),
  assignedLine: text("assigned_line"),
  threadId: text("thread_id"),
  /** `iMessage`, `SMS`, or `RCS` from the last inbound message. */
  lastService: text("last_service"),
  verifiedAt: timestamptz("verified_at"),
  lastInboundAt: timestamptz("last_inbound_at"),
  createdAt: createdAt(),
});

/**
 * A member's conversations with the assistant. Each member has one `thread`: the eve session their
 * iMessage texts run in, which the web app's Assistant page resumes, so texts and web turns are one
 * history. A `job` is a side conversation for one piece of work, under the thread (`parent_id`), with
 * its own eve session, optionally about one quote or customer.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    kind: conversationKind("kind").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => conversations.id),
    /** Null only for a job that hasn't started its session yet. */
    eveSessionId: text("eve_session_id").unique(),
    title: text("title"),
    status: conversationStatus("status").notNull().default("active"),
    /** A job's quote, when it's about one. */
    quoteId: text("quote_id").references((): AnyPgColumn => quotes.id),
    /** A job's customer, when it's about one. */
    customerId: text("customer_id").references((): AnyPgColumn => customers.id),
    /**
     * `email` for a thread an email the member forwarded started, `web` for the member's thread Home
     * started; null for the rest.
     */
    source: text("source"),
    /**
     * An email thread's conversation: who wrote the original and its subject, without "Re:" or "Fwd:"
     * (`emailThreadKey`), so the next email about the same thing joins it instead of starting another.
     */
    emailKey: text("email_key"),
    /** When its member last looked at it on the web: an email thread with news since then counts as unread. */
    seenAt: timestamptz("seen_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversations_member_thread_idx").on(t.orgId, t.memberId).where(sql`${t.kind} = 'thread'`),
    index("conversations_org_parent_idx").on(t.orgId, t.parentId),
    index("conversations_org_member_kind_idx").on(t.orgId, t.memberId, t.kind),
    index("conversations_org_quote_idx").on(t.orgId, t.quoteId),
    index("conversations_org_customer_idx").on(t.orgId, t.customerId),
    index("conversations_org_member_email_idx").on(t.orgId, t.memberId, t.emailKey),
  ],
);

export const pricebookItems = pgTable(
  "pricebook_items",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    unitKind: unitKind("unit_kind").notNull(),
    unitLabel: text("unit_label").notNull(),
    priceCents: integer("price_cents").notNull(),
    taxable: boolean("taxable").notNull().default(true),
    group: text("group"),
    notes: text("notes"),
    /** The noun phrase that finds this item in a photo ("mulch bed"), for the priced photo; null for none. */
    photoPrompt: text("photo_prompt"),
    status: itemStatus("status").notNull().default("active"),
    createdFromQuoteId: text("created_from_quote_id"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pricebook_items_org_name_key_idx").on(t.orgId, t.nameKey)],
);

export const pricebookChanges = pgTable("pricebook_changes", {
  id: text("id").primaryKey(),
  orgId: orgId(),
  itemId: text("item_id")
    .notNull()
    .references(() => pricebookItems.id),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value").notNull(),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id),
  sourceMessageId: text("source_message_id"),
  version: integer("version").notNull(),
  createdAt: createdAt(),
});

export const rules = pgTable(
  "rules",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    text: text("text").notNull(),
    kind: ruleKind("kind").notNull(),
    effect: jsonb("effect").$type<RuleEffect | null>(),
    status: ruleStatus("status").notNull().default("active"),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    sourceMessageId: text("source_message_id"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    retiredAt: timestamptz("retired_at"),
  },
  (t) => [index("rules_org_idx").on(t.orgId)],
);

/**
 * A customer. Their people and numbers are `customer_contacts`. `phones` and `emails` are kept equal to
 * every contact's, the preferred contact's first (`syncContactMirror` in core/customers.ts), for
 * the PDFs and the pay link; a trigger files anything written straight to them under the preferred
 * contact. `revision` counts changes, so a web edit made on a stale page is
 * refused. Archived customers leave every list and search, and their quotes and invoices stay; a merged
 * one is archived with `merged_into_id` set to the customer it became.
 */
export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    phones: text("phones").array().notNull().default([]),
    emails: text("emails").array().notNull().default([]),
    language: languageCode("language").notNull().default("en"),
    notes: text("notes"),
    revision: integer("revision").notNull().default(1),
    archivedAt: timestamptz("archived_at"),
    archivedByMemberId: text("archived_by_member_id").references(() => members.id),
    mergedIntoId: text("merged_into_id").references((): AnyPgColumn => customers.id),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("customers_org_idx").on(t.orgId)],
);

/**
 * Someone to reach about a customer: the customer themself, or a tenant, a property manager, a spouse.
 * `role` is the member's own word for them. At most one contact per customer is `preferred`: the one
 * quotes and emails go to first.
 */
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    name: text("name").notNull(),
    role: text("role"),
    phones: text("phones").array().notNull().default([]),
    emails: text("emails").array().notNull().default([]),
    preferred: boolean("preferred").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("customer_contacts_org_customer_idx").on(t.orgId, t.customerId),
    uniqueIndex("customer_contacts_preferred_idx").on(t.orgId, t.customerId).where(sql`${t.preferred}`),
  ],
);

/**
 * Every change to a customer, its contacts, and its properties: who (`member_id`, null for the system),
 * what (`kind`, with the record as it was `before` and is `after`), and when.
 */
export const customerChanges = pgTable(
  "customer_changes",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    memberId: text("member_id").references(() => members.id),
    kind: text("kind").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [index("customer_changes_org_customer_idx").on(t.orgId, t.customerId, t.createdAt)],
);

export const properties = pgTable("properties", {
  id: text("id").primaryKey(),
  orgId: orgId(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  address: text("address").notNull(),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const quotes = pgTable(
  "quotes",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    title: text("title").notNull(),
    customerId: text("customer_id").references(() => customers.id),
    propertyId: text("property_id").references(() => properties.id),
    status: quoteStatus("status").notNull().default("draft"),
    /** Plain column, no FK: quote_revisions.quote_id already points back here. */
    currentRevisionId: text("current_revision_id"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => members.id),
    threadSessionId: text("thread_session_id"),
    approvedAt: timestamptz("approved_at"),
    approvedByMemberId: text("approved_by_member_id").references(() => members.id),
    outcomeAt: timestamptz("outcome_at"),
    /** The key in the customer's link to the quote (/q/<token>), made the first time the link is asked for. */
    customerToken: text("customer_token").unique(),
    /** When the customer approved it on that link, the name they signed with, and the revision they saw. */
    customerApprovedAt: timestamptz("customer_approved_at"),
    customerApprovedName: text("customer_approved_name"),
    customerApprovedRevisionId: text("customer_approved_revision_id"),
    /** The deposit asked at the customer's approval (the business's share of that revision's total). Null asks none. */
    depositCents: integer("deposit_cents"),
    /** The last Stripe Checkout Session the deposit button opened. */
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("quotes_org_updated_idx").on(t.orgId, t.updatedAt),
    check("quotes_deposit", sql`${t.depositCents} is null or ${t.depositCents} > 0`),
  ],
);

export const quoteRevisions = pgTable(
  "quote_revisions",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    number: integer("number").notNull(),
    lines: jsonb("lines").$type<LineResult[]>().notNull(),
    ruleLines: jsonb("rule_lines").$type<RuleLine[]>().notNull(),
    adjustments: jsonb("adjustments").$type<Adjustment[]>().notNull(),
    ruleIds: text("rule_ids").array().notNull().default([]),
    /** `ready` or `needs_owner`. */
    state: text("state").notNull(),
    reasons: text("reasons").array().notNull().default([]),
    linesSubtotalCents: integer("lines_subtotal_cents").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    minimumAppliedCents: integer("minimum_applied_cents").notNull(),
    adjustmentCents: integer("adjustment_cents").notNull(),
    preTaxCents: integer("pre_tax_cents").notNull(),
    taxableCents: integer("taxable_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    taxRateBp: integer("tax_rate_bp"),
    pricebookVersion: integer("pricebook_version").notNull(),
    rulesVersion: integer("rules_version").notNull(),
    profileVersion: integer("profile_version").notNull(),
    calcHash: text("calc_hash").notNull(),
    pdfUrl: text("pdf_url"),
    validUntil: date("valid_until", { mode: "string" }).notNull(),
    customerLanguage: languageCode("customer_language").notNull(),
    customerNotes: text("customer_notes"),
    privateNotes: text("private_notes"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("quote_revisions_quote_number_idx").on(t.quoteId, t.number)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    memberId: text("member_id").references(() => members.id),
    /** Null on what a member sent from web chat: it came in on no phone. */
    phoneE164: text("phone_e164"),
    direction: messageDirection("direction").notNull(),
    kind: messageKind("kind").notNull(),
    providerMessageId: text("provider_message_id").unique(),
    threadId: text("thread_id"),
    /** The emoji glyph for a `reaction`. */
    body: text("body").notNull(),
    attachments: jsonb("attachments").$type<InboundAttachment[]>().notNull().default([]),
    /** Set on outbound posts about a quote, so a tapback on them resolves the quote. */
    quoteId: text("quote_id").references(() => quotes.id),
    /** An outbound post that asks the member to approve `quoteId`, so a 👍 on it can mean "ok". */
    asksApproval: boolean("asks_approval").notNull().default(false),
    /** The Photon id an inbound tapback targets. */
    targetProviderMessageId: text("target_provider_message_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_member_created_idx").on(t.memberId, t.createdAt)],
);

export const quoteAttachments = pgTable(
  "quote_attachments",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    /** The text it came in on; null for a photo uploaded on the quote's page. */
    messageId: text("message_id").references(() => messages.id),
    /** Who uploaded it on the quote's page; null for a texted photo. */
    uploadedByMemberId: text("uploaded_by_member_id").references(() => members.id),
    url: text("url").notNull(),
    name: text("name"),
    mimeType: text("mime_type"),
    description: text("description"),
    /** Taken off the quote by a member. The row stays, so the photo isn't attached again. */
    removedAt: timestamptz("removed_at"),
    createdAt: createdAt(),
  },
  (t) => [check("quote_attachments_source", sql`${t.messageId} is not null or ${t.uploadedByMemberId} is not null`)],
);

/**
 * A quote's photo with each quoted thing outlined and labeled with its line's quantity and price
 * (core/priced-photo.ts): one per quote per source photo, replaced when made again. The source is a
 * quote attachment before the job or a work photo after it. `url` is the rendered PNG.
 */
export const pricedPhotos = pgTable(
  "priced_photos",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quotes.id),
    revisionNumber: integer("revision_number").notNull(),
    sourceKind: text("source_kind").$type<"quote_attachment" | "work_photo">().notNull(),
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    url: text("url").notNull(),
    /**
     * The copy customers see when the business hides line prices: each region labeled with its quantity
     * only. Drawn beside `url` from the same masks; null only on photos made before it was drawn.
     */
    customerUrl: text("customer_url"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** The photo's height under the legend, in the pixels the candidates are in; null only on photos made before it was kept. */
    photoHeight: integer("photo_height"),
    regions: jsonb("regions").$type<PricedRegion[]>().notNull(),
    /** Every object SAM found, kept with its outline, so a member can move them between lines without another SAM call. */
    candidates: jsonb("candidates").$type<PricedCandidate[]>().notNull().default([]),
    memberId: text("member_id").references(() => members.id),
    createdAt: createdAt(),
    /** The member who last changed which objects a line has, and when; null until someone does. */
    editedBy: text("edited_by").references(() => members.id),
    editedAt: timestamptz("edited_at"),
  },
  (t) => [uniqueIndex("priced_photos_org_quote_source_idx").on(t.orgId, t.quoteId, t.sourceUrl)],
);

/**
 * What the business wants remembered beyond prices. A `note` is text: how the business does things
 * (procedures, checklists, warranty terms, policies, crew instructions) when it is linked to nothing,
 * or a site note (a gate code, where to park) on a customer, a property, or a quote. A `document` is a
 * file a member texted in and asked to keep, with its title, their description, and any text read from
 * it in `body`. `revision` counts changes; archived notes leave lists and search.
 */
export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    kind: noteKind("kind").notNull().default("note"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    tags: text("tags").array().notNull().default([]),
    customerId: text("customer_id").references(() => customers.id),
    propertyId: text("property_id").references(() => properties.id),
    quoteId: text("quote_id").references(() => quotes.id),
    files: jsonb("files").$type<NoteFile[]>().notNull().default([]),
    revision: integer("revision").notNull().default(1),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => members.id),
    updatedByMemberId: text("updated_by_member_id")
      .notNull()
      .references(() => members.id),
    archivedAt: timestamptz("archived_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("notes_org_updated_idx").on(t.orgId, t.updatedAt),
    index("notes_org_customer_idx").on(t.orgId, t.customerId),
    index("notes_org_property_idx").on(t.orgId, t.propertyId),
  ],
);

/**
 * The business's own words in Spanish: an English term and the Spanish one to use for it, with an
 * optional note. The translator and the assistant (writing to a Spanish-speaking member) both follow
 * it. One row per English term, whatever its case.
 */
export const glossaryTerms = pgTable(
  "glossary_terms",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    term: text("term").notNull(),
    spanish: text("spanish").notNull(),
    note: text("note").notNull().default(""),
    updatedByMemberId: text("updated_by_member_id").references(() => members.id),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("glossary_terms_org_term_idx").on(t.orgId, sql`lower(${t.term})`)],
);

/**
 * Cached translations of message text, for the web app's translated view. The stored message stays
 * the record; this is a view of it. Keyed by the source text's hash, the target language, and the
 * glossary's hash, so a glossary change translates again. `source_language` is what the model read
 * the text as (`en`, `es`, or `other`); `text` is empty when it was already in the target language.
 */
export const translations = pgTable(
  "translations",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    sourceHash: text("source_hash").notNull(),
    language: languageCode("language").notNull(),
    glossaryHash: text("glossary_hash").notNull(),
    sourceLanguage: text("source_language").notNull(),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("translations_org_key_idx").on(t.orgId, t.sourceHash, t.language, t.glossaryHash),
    index("translations_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  orgId: orgId(),
  quoteRevisionId: text("quote_revision_id")
    .notNull()
    .references(() => quoteRevisions.id),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id),
  messageId: text("message_id"),
  createdAt: createdAt(),
});

export const ownerRequests = pgTable("owner_requests", {
  id: text("id").primaryKey(),
  orgId: orgId(),
  quoteId: text("quote_id")
    .notNull()
    .references(() => quotes.id),
  requestedByMemberId: text("requested_by_member_id")
    .notNull()
    .references(() => members.id),
  status: ownerRequestStatus("status").notNull().default("pending"),
  createdAt: createdAt(),
  resolvedAt: timestamptz("resolved_at"),
});

export const followups = pgTable(
  "followups",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    quoteId: text("quote_id").references(() => quotes.id),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    kind: followupKind("kind").notNull(),
    dueAt: timestamptz("due_at").notNull(),
    status: followupStatus("status").notNull().default("pending"),
    sentMessageId: text("sent_message_id"),
    /** What a `notice` says, and whether it asks the member to approve `quoteId`. */
    /** A notice's text; `conversationId` is the email thread it's a reply from, dropped once its member opens that thread. */
    payload: jsonb("payload").$type<{ text: string; asksApproval: boolean; conversationId?: string } | null>(),
    createdAt: createdAt(),
  },
  (t) => [index("followups_org_due_idx").on(t.orgId, t.status, t.dueAt)],
);

/** `key` makes an event idempotent within its business. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    kind: text("kind").notNull(),
    key: text("key"),
    refId: text("ref_id"),
    memberId: text("member_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("events_org_key_idx").on(t.orgId, t.key)],
);

/**
 * One inbound Photon webhook delivery (a member's text or tapback), or an email a member forwarded to the
 * business's inbox, stored before the provider gets its 200, so an instance that stops mid-turn can't
 * lose it. `provider_message_id` is unique: Photon and AgentMail deliver at least once. Handled one at a time per member, in order (`sent_at`), under a lease (`lease_until`); a
 * failed try waits (`next_attempt_at`) and retries, and the last one leaves it `dead`. `progress` is
 * what earlier tries already did (the welcome, the hand-off to eve), so a retry doesn't repeat it.
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    providerMessageId: text("provider_message_id").notNull().unique(),
    webhookId: text("webhook_id"),
    /** `message` or `reaction` from Photon; `email` for an email the member forwarded (core/email-intake.ts). */
    kind: text("kind").notNull(),
    /** The member's iMessage thread: where the turn runs and its reply is texted. */
    threadId: text("thread_id").notNull(),
    /** The verified webhook body: `{ event, message, space }`, or for an email the parsed `ForwardedEmail`. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    progress: jsonb("progress").$type<DeliveryProgress>().notNull().default({}),
    /** How it was handled, once `done`: the inbound decision (`dispatch`, `ignore:duplicate`, …). */
    outcome: text("outcome"),
    lastError: text("last_error"),
    sentAt: timestamptz("sent_at").notNull().defaultNow(),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    leaseUntil: timestamptz("lease_until"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("deliveries_org_member_status_idx").on(t.orgId, t.memberId, t.status, t.sentAt),
    index("deliveries_status_next_idx").on(t.status, t.nextAttemptAt),
  ],
);

/**
 * What happened in a member's conversations with the assistant, from eve's event stream
 * (`agents/assistant/agent/hooks/persist.ts`): messages received and completed, tool calls (name, status, duration,
 * redacted input), and turns started, completed, failed, or cancelled. `id` is eve's event id, so a
 * re-read event is stored once. A session is recorded only under the conversation it belongs to.
 * `delivery_id` is the inbound text (`deliveries`) whose turn this is. Pruned after 180 days.
 */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    memberId: text("member_id").references(() => members.id),
    eveSessionId: text("eve_session_id").notNull(),
    turnId: text("turn_id"),
    kind: text("kind").notNull(),
    deliveryId: text("delivery_id"),
    toolName: text("tool_name"),
    toolCallId: text("tool_call_id"),
    /** A tool call's `ok` or `error`; a turn's `completed`, `failed`, or `cancelled`. */
    status: text("status"),
    durationMs: integer("duration_ms"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("conversation_events_org_conversation_idx").on(t.orgId, t.conversationId, t.createdAt),
    index("conversation_events_org_created_idx").on(t.orgId, t.createdAt),
    index("conversation_events_org_delivery_idx").on(t.orgId, t.deliveryId),
    index("conversation_events_org_call_idx").on(t.orgId, t.toolCallId),
  ],
);

/**
 * What the assistant did in one turn, from eve's event stream (`agents/assistant/agent/hooks/trace.ts`):
 * the model, each step's tool calls with their inputs and outputs, its reasoning and messages, and the
 * turn's token totals. One row per turn, its steps appended as events arrive. Unlike
 * `conversation_events`, inputs and outputs are kept whole (up to 32 KB each); redaction happens on
 * export. `conversation_id` is null for a session with no conversation, like an eval's. `source` is
 * where the turn came from: `web`, `text`, `email`, `job`, `local`, or `other`.
 */
export const turnTraces = pgTable(
  "turn_traces",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    conversationId: text("conversation_id").references(() => conversations.id),
    memberId: text("member_id").references(() => members.id),
    eveSessionId: text("eve_session_id").notNull(),
    turnId: text("turn_id").notNull(),
    source: text("source").notNull(),
    modelId: text("model_id"),
    /** `running`, then `completed`, `failed`, or `cancelled`. */
    status: text("status").notNull().default("running"),
    steps: jsonb("steps").$type<TraceStep[]>().notNull().default([]),
    usage: jsonb("usage").$type<TraceUsage>(),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("turn_traces_org_session_turn_idx").on(t.orgId, t.eveSessionId, t.turnId),
    index("turn_traces_org_conversation_idx").on(t.orgId, t.conversationId, t.startedAt),
  ],
);

/**
 * A sign-in code the assistant texted a member. Only its hash is stored, and the text it went out in is
 * logged without it. Single use: `consumed_at` is set when it signs someone in or a newer code replaces it.
 */
export const loginCodes = pgTable(
  "login_codes",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    phoneE164: text("phone_e164").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("login_codes_phone_created_idx").on(t.phoneE164, t.createdAt)],
);

/**
 * The work itself: what a won quote becomes, or work booked on its own. Its visits are when the crew go.
 * `quote_revision_id` is the revision the work was agreed on. A quote has at most one job that isn't
 * cancelled, so booking a quote twice adds visits to the same job.
 */
export const serviceJobs = pgTable(
  "service_jobs",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    title: text("title").notNull(),
    customerId: text("customer_id").references(() => customers.id),
    propertyId: text("property_id").references(() => properties.id),
    quoteId: text("quote_id").references(() => quotes.id),
    quoteRevisionId: text("quote_revision_id").references(() => quoteRevisions.id),
    status: serviceJobStatus("status").notNull().default("open"),
    notes: text("notes"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => members.id),
    closedAt: timestamptz("closed_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("service_jobs_org_status_idx").on(t.orgId, t.status),
    index("service_jobs_org_customer_idx").on(t.orgId, t.customerId),
    uniqueIndex("service_jobs_org_quote_idx").on(t.orgId, t.quoteId).where(sql`${t.quoteId} is not null and ${t.status} <> 'cancelled'`),
  ],
);

/**
 * One trip to do a job's work, with one or more crew (`visit_crew`). Times are instants; the business's
 * time zone says what day and hour they are. Buffers are minutes held before and after, for travel or
 * setup. `revision` counts changes, each kept in `visit_revisions`.
 */
export const visits = pgTable(
  "visits",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => serviceJobs.id),
    startAt: timestamptz("start_at").notNull(),
    endAt: timestamptz("end_at").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    status: visitStatus("status").notNull().default("scheduled"),
    notes: text("notes"),
    revision: integer("revision").notNull().default(1),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => members.id),
    completedAt: timestamptz("completed_at"),
    cancelledAt: timestamptz("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("visits_org_start_idx").on(t.orgId, t.startAt),
    index("visits_org_job_idx").on(t.orgId, t.jobId),
    check("visits_interval", sql`${t.endAt} > ${t.startAt}`),
    check("visits_buffers", sql`${t.bufferBeforeMinutes} between 0 and 480 and ${t.bufferAfterMinutes} between 0 and 480`),
  ],
);

/** Who goes on a visit: one row per crew member. */
export const visitCrew = pgTable(
  "visit_crew",
  {
    orgId: orgId(),
    visitId: text("visit_id")
      .notNull()
      .references(() => visits.id),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
  },
  (t) => [primaryKey({ columns: [t.visitId, t.memberId] }), index("visit_crew_org_member_idx").on(t.orgId, t.memberId)],
);

/** Every change to a visit, as it was after the change: booked, moved, crew changed, completed, cancelled. */
export const visitRevisions = pgTable(
  "visit_revisions",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    visitId: text("visit_id")
      .notNull()
      .references(() => visits.id),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("visit_revisions_visit_revision_idx").on(t.orgId, t.visitId, t.revision)],
);

/**
 * A photo of the work itself (often the finished job), on the work and, when known, the visit it was
 * taken on. Texted in (`message_id`, the text it came on) or uploaded on the work's page. Anyone on the
 * team adds them; whoever added one, or an owner or admin, takes it off (`removed_at`; the row stays, so
 * a texted photo isn't attached again).
 */
export const workPhotos = pgTable(
  "work_photos",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => serviceJobs.id),
    visitId: text("visit_id").references(() => visits.id),
    messageId: text("message_id").references(() => messages.id),
    addedByMemberId: text("added_by_member_id")
      .notNull()
      .references(() => members.id),
    url: text("url").notNull(),
    name: text("name"),
    mimeType: text("mime_type"),
    description: text("description"),
    removedAt: timestamptz("removed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("work_photos_org_job_idx").on(t.orgId, t.jobId),
    uniqueIndex("work_photos_message_url_idx").on(t.orgId, t.messageId, t.url).where(sql`${t.messageId} is not null`),
  ],
);

/**
 * The work's checklist: one item per line of its quote's current revision, in line order, made when its
 * first visit is booked. `located` says the quote's priced photo outlines that line. The text is built in
 * the reader's language from `name`, `quantity`, and `unit_label`, never stored. Anyone on the team ticks
 * an item (`done_at`, `done_by_member_id`) or unticks it.
 */
export const checklistItems = pgTable(
  "checklist_items",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => serviceJobs.id),
    lineIndex: integer("line_index").notNull(),
    name: text("name").notNull(),
    quantity: numeric("quantity", { mode: "number" }).notNull(),
    unitLabel: text("unit_label").notNull(),
    located: boolean("located").notNull().default(false),
    doneAt: timestamptz("done_at"),
    doneByMemberId: text("done_by_member_id").references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("checklist_items_org_job_line_idx").on(t.orgId, t.jobId, t.lineIndex)],
);

/** Time off: a member (or, with no member, the whole business) can't take visits from `start_at` to `end_at`. */
export const busyBlocks = pgTable(
  "busy_blocks",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    memberId: text("member_id").references(() => members.id),
    startAt: timestamptz("start_at").notNull(),
    endAt: timestamptz("end_at").notNull(),
    reason: text("reason"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => members.id),
    cancelledAt: timestamptz("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [index("busy_blocks_org_start_idx").on(t.orgId, t.startAt), check("busy_blocks_interval", sql`${t.endAt} > ${t.startAt}`)],
);

/**
 * A bill for work: from a completed job or an agreed quote (its lines copied from the agreed revision),
 * or written from scratch. Lines are editable while it's a draft and frozen once it's sent. Every amount
 * is computed by `calculate`, as quotes are; `rule_lines` are the quote's extras, kept as fixed amounts.
 * `number` is per business (INV-0001). `pay_token` is the unguessable part of its pay link.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    customerId: text("customer_id").references(() => customers.id),
    propertyId: text("property_id").references(() => properties.id),
    serviceJobId: text("service_job_id").references(() => serviceJobs.id),
    quoteId: text("quote_id").references(() => quotes.id),
    quoteRevisionId: text("quote_revision_id").references(() => quoteRevisions.id),
    status: invoiceStatus("status").notNull().default("draft"),
    /** Set when it's sent, in the business's time zone. */
    issueDate: date("issue_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    lines: jsonb("lines").$type<InvoiceLine[]>().notNull(),
    ruleLines: jsonb("rule_lines").$type<RuleLine[]>().notNull().default([]),
    adjustments: jsonb("adjustments").$type<Adjustment[]>().notNull().default([]),
    /** The minimum charge carried from the quote; null for none. */
    minimumCents: integer("minimum_cents"),
    taxRateBp: integer("tax_rate_bp"),
    subtotalCents: integer("subtotal_cents").notNull(),
    minimumAppliedCents: integer("minimum_applied_cents").notNull().default(0),
    adjustmentCents: integer("adjustment_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    /** What its payments add up to. Above the total only when a card payment came in for more than was owed. */
    amountPaidCents: integer("amount_paid_cents").notNull().default(0),
    language: languageCode("language").notNull().default("en"),
    notes: text("notes"),
    /** The work's photos chosen for its PDF (`work_photos` ids), in the order they were taken. */
    pdfPhotoIds: jsonb("pdf_photo_ids").$type<string[]>().notNull().default([]),
    pdfUrl: text("pdf_url"),
    payToken: text("pay_token").notNull().unique(),
    /** The last Stripe Checkout Session its pay link opened. */
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    createdByMemberId: text("created_by_member_id")
      .notNull()
      .references(() => members.id),
    sentByMemberId: text("sent_by_member_id").references(() => members.id),
    sentAt: timestamptz("sent_at"),
    paidAt: timestamptz("paid_at"),
    voidedAt: timestamptz("voided_at"),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_org_number_idx").on(t.orgId, t.number),
    index("invoices_org_status_idx").on(t.orgId, t.status),
    index("invoices_org_customer_idx").on(t.orgId, t.customerId),
    // One invoice per job and per quote, unless it's voided: a second ask returns the first.
    uniqueIndex("invoices_org_job_idx").on(t.orgId, t.serviceJobId).where(sql`${t.serviceJobId} is not null and ${t.status} <> 'void'`),
    uniqueIndex("invoices_org_quote_idx").on(t.orgId, t.quoteId).where(sql`${t.quoteId} is not null and ${t.status} <> 'void'`),
    check("invoices_amounts", sql`${t.totalCents} >= 0 and ${t.amountPaidCents} >= 0`),
  ],
);

/**
 * Money received against an invoice: recorded by a member (cash, check, card taken in person) or paid
 * through the invoice's pay link (Stripe). `removed_at` takes a mistaken manual entry back off its
 * invoice; the row stays for the record.
 *
 * A deposit is paid on a quote's link before there's an invoice: it has `quote_id` and no `invoice_id`
 * until the quote (or its work) is invoiced, when it moves onto that invoice and keeps its `quote_id`.
 */
export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    /** Null only for a deposit not yet on an invoice. */
    invoiceId: text("invoice_id").references(() => invoices.id),
    /** The quote a deposit was paid on. */
    quoteId: text("quote_id").references(() => quotes.id),
    amountCents: integer("amount_cents").notNull(),
    method: paymentMethod("method").notNull(),
    /** The day it came in, in the business's time zone. */
    receivedDate: date("received_date", { mode: "string" }).notNull(),
    reference: text("reference"),
    source: paymentSource("source").notNull().default("manual"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    /**
     * The card a Stripe payment was made with, from its charge (`visa`, `4242`), for the receipt and the
     * invoice page. Null for a manual payment, and when Stripe couldn't be asked.
     */
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    /**
     * What the business has refunded of it in Stripe, all told. `amount_cents` is what it still keeps; a
     * payment refunded in full is taken off (`removed_at`, with no member) and keeps the amount it had.
     */
    refundedCents: integer("refunded_cents").notNull().default(0),
    /** Null for a Stripe payment. */
    recordedByMemberId: text("recorded_by_member_id").references(() => members.id),
    removedAt: timestamptz("removed_at"),
    removedByMemberId: text("removed_by_member_id").references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("payments_org_invoice_idx").on(t.orgId, t.invoiceId),
    index("payments_org_quote_idx").on(t.orgId, t.quoteId),
    check("payments_belongs", sql`${t.invoiceId} is not null or ${t.quoteId} is not null`),
    index("payments_org_created_idx").on(t.orgId, t.createdAt),
    // A Checkout Session pays once, however many of its events arrive.
    uniqueIndex("payments_stripe_session_idx").on(t.stripeCheckoutSessionId),
    check("payments_amount", sql`${t.amountCents} > 0`),
    check("payments_refunded", sql`${t.refundedCents} >= 0`),
  ],
);

/**
 * The business's own Stripe account (Connect, Standard), which its invoices' pay links charge on.
 * `account_id` is unique across businesses: a webhook finds its business by it. One row per business.
 */
export const stripeAccounts = pgTable("stripe_accounts", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id),
  accountId: text("account_id").notNull().unique(),
  status: stripeAccountStatus("status").notNull().default("onboarding"),
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  connectedByMemberId: text("connected_by_member_id").references(() => members.id),
  createdAt: createdAt(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/**
 * Stripe webhook events already handled, so a redelivered one changes nothing. `org_id` is the business
 * whose connected account it came from.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    eventId: text("event_id").primaryKey(),
    orgId: orgId(),
    type: text("type").notNull(),
    /** What handling it did: `payment`, `account`, `ignored`, and so on. */
    outcome: text("outcome").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("stripe_events_org_idx").on(t.orgId)],
);

/**
 * One model call's usage receipt (`core/usage.ts`): the tokens the provider reported, the model
 * deployment, and an estimated cost from the pricing table (`core/model-pricing.ts`; list prices,
 * not the account's bill). Written by the metered model (`core/metered-model.ts`) for every call,
 * compaction summaries included. `event_key` makes a replayed call one receipt. `reservation_id` is the
 * admitted turn it counts against (`turn_reservations`), when it had one. Member and conversation are
 * null for a call that ran without either (local dev's owner fallback).
 */
export const usageReceipts = pgTable(
  "usage_receipts",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    eventKey: text("event_key").notNull(),
    memberId: text("member_id").references(() => members.id),
    conversationId: text("conversation_id").references(() => conversations.id),
    eveSessionId: text("eve_session_id"),
    turnId: text("turn_id"),
    stepIndex: integer("step_index"),
    reservationId: text("reservation_id"),
    /** Where the turn came from: `text`, `web`, `job`, `schedule`, `local` (dev and evals), or `other`; `translation` is no turn. */
    channel: text("channel").notNull(),
    /**
     * `step` for an ordinary model call, `compaction` for a history summary, `translation` for the web
     * app's translated view, `sam` for a priced photo's segmentation call.
     */
    kind: text("kind").notNull().default("step"),
    /** The deployment the call went to, and the model id the provider answered with. */
    deployment: text("deployment").notNull(),
    responseModel: text("response_model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Part of `output_tokens`, when the provider reports it. */
    reasoningTokens: integer("reasoning_tokens"),
    /** The images a SAM call processed; null for a token-billed call. */
    images: integer("images"),
    /** An estimate from list prices, in US dollars. */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 8, mode: "number" }).notNull().default(0),
    /** Which prices the estimate used: `table`, `env` (MODEL_PRICES), or `fallback` (an unlisted deployment). */
    priceSource: text("price_source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("usage_receipts_org_event_idx").on(t.orgId, t.eventKey),
    index("usage_receipts_org_created_idx").on(t.orgId, t.createdAt),
    index("usage_receipts_org_reservation_idx").on(t.orgId, t.reservationId),
  ],
);

/**
 * A turn admitted under its business's usage limits (`core/usage-limits.ts`), reserved before it
 * starts: a text at the inbound queue's hand-off, a web or job turn in eve's channel auth. `reserved`
 * until eve starts it, `running` until it ends, then `settled`. `released` never reached a turn and
 * doesn't count; `merged` was folded into another turn of the same session; `expired` stalled past its
 * lease (15 minutes since it was admitted or last heard from) and stops holding a slot. `key` keeps a
 * retried hand-off on one reservation.
 */
export const turnReservations = pgTable(
  "turn_reservations",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    key: text("key").notNull(),
    memberId: text("member_id").references(() => members.id),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("reserved"),
    /** Output tokens held for the turn until its receipts come in. */
    reservedOutputTokens: integer("reserved_output_tokens").notNull(),
    eveSessionId: text("eve_session_id"),
    turnId: text("turn_id"),
    leaseUntil: timestamptz("lease_until").notNull(),
    startedAt: timestamptz("started_at"),
    settledAt: timestamptz("settled_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("turn_reservations_org_created_idx").on(t.orgId, t.createdAt),
    index("turn_reservations_org_status_idx").on(t.orgId, t.status),
    index("turn_reservations_org_key_idx").on(t.orgId, t.key),
  ],
);

/**
 * A business's own usage limits, set by a super admin. A null column uses the app's default
 * (`core/usage-limits.ts`). No row: every default.
 */
export const usageLimits = pgTable("usage_limits", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id),
  hourlyTurns: integer("hourly_turns"),
  hourlyOutputTokens: integer("hourly_output_tokens"),
  concurrentTurns: integer("concurrent_turns"),
  updatedBy: text("updated_by"),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/**
 * A business's own designs for its customer pages (a quote's link, an invoice's pay link): every
 * version of each page's template (core/customer-page-template.ts), newest last. Templates hold
 * slots, never a quote's or invoice's facts. `request` is what the owner asked for that version.
 */
export const customerPageVersions = pgTable(
  "customer_page_versions",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    page: text("page").notNull(),
    version: integer("version").notNull(),
    html: text("html").notNull(),
    request: text("request"),
    memberId: text("member_id").references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("customer_page_versions_org_page_version_idx").on(t.orgId, t.page, t.version)],
);

/**
 * Which version of a customer page is live. No row, or a null `published_version`: the app's
 * standard page.
 */
export const customerPages = pgTable(
  "customer_pages",
  {
    orgId: orgId(),
    page: text("page").notNull(),
    publishedVersion: integer("published_version"),
    publishedAt: timestamptz("published_at"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.page] })],
);

/**
 * A member's conversation with one of the app's agents other than the assistant (agents/<agent>/), one
 * per subject: the designer's for each customer page (`subject` "quote" or "invoice"). The assistant's
 * own conversations are `conversations`.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    orgId: orgId(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    agent: text("agent").notNull(),
    subject: text("subject").notNull(),
    eveSessionId: text("eve_session_id").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.memberId, t.agent, t.subject] })],
);
