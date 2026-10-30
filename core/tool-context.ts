import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { SessionAuthContext } from "eve/context";
import { messages } from "../schema/schema";
import { db } from "./db";
import { resolveCaller, type Caller } from "./members";
import { BusinessSuspendedError, isSuspended } from "./organizations";
import { quoteSummaryText, type QuoteSummary } from "./quotes";

/**
 * The member behind this turn. Throws `UNKNOWN_CALLER` for anyone who is not an active member, and
 * `BUSINESS_SUSPENDED` while a super admin has the business paused.
 */
export async function requireCaller(ctx: {
  session: { auth: { current: SessionAuthContext | null } };
}): Promise<Caller> {
  const caller = await resolveCaller(ctx.session.auth.current);
  if (!caller) throw new Error("UNKNOWN_CALLER");
  if (await isSuspended(caller.orgId)) throw new BusinessSuspendedError();
  return caller;
}

/** The auth a turn runs under, as tools and dynamic resolvers see it. */
type TurnAuth = { attributes?: Record<string, unknown> } | null | undefined;

/**
 * True when this turn is an email a member forwarded (core/email-intake.ts sets `origin` on the
 * turn's auth). The email is someone else's words, so it can't stand for the member's say-so.
 */
export function isEmailTurn(auth: TurnAuth): boolean {
  return auth?.attributes?.origin === "email";
}

/**
 * Refuses (`FROM_EMAIL`) what an email must not do by itself: send or approve quotes and invoices, take or
 * remove payments, change the team, prices, rules, or business details, change or finalize quotes,
 * customers, notes, or visits already on record, or open a job (whose turns would run without the email's
 * mark). New drafts and records are fine. The member confirms the rest by text or on the web, in a turn of
 * their own. core/email-gate.test.ts holds every tool to a decision.
 */
export function refuseFromEmail(ctx: { session: { auth: { current: TurnAuth } } }): void {
  if (isEmailTurn(ctx.session.auth.current)) throw new Error("FROM_EMAIL");
}

// Plain-language hints for the codes the libraries throw, so the model can say what went wrong.
const HINTS: Record<string, string> = {
  UNKNOWN_CALLER: "This person is not an active member of the business.",
  FROM_EMAIL:
    "This turn is a forwarded email, so nothing was done: sending, approving, payments, the team, prices, rules, business details, and changes to quotes, customers, notes, or the schedule already on record need the member's own go-ahead. New drafts and records are fine. In your text, say what you'd change and ask them to reply to confirm.",
  EMAIL_IN_USE: "Another member of the business already forwards from that address.",
  EMAIL_NO_INBOX: "The business doesn't have an email address to forward to yet, so there's nothing to turn on. Say so in one line.",
  EMAIL_CLAIM_LIMIT: "That member has asked for several new addresses today. Say to try again tomorrow.",
  EMAIL_IS_CUSTOMER: "That address is one of the business's customers', so it can't be a member's. Ask for the member's own address.",
  BUSINESS_SUSPENDED: "This business is paused, so nothing can be done for it right now. Say so in one line.",
  NOT_PRIVILEGED:
    "Only the owner or an admin can do that, and for another member only someone above them: the owner manages admins and crew, an admin manages crew. Say so in one line.",
  LAST_OWNER: "The business has to keep at least one owner.",
  NOT_YOUR_QUOTE:
    "Crew change someone else's quote only while it's a draft. This one has been approved or sent, so say in one line that the owner, an admin, or whoever started it can change it.",
  OWNER_ONLY: "Only the owner can change that. Say so in one line.",
  ROLE_OWNER_ONLY: "Only the owner changes who is an admin and who is crew. Say so in one line.",
  OWN_ROLE: "Nobody changes their own role. Say so in one line.",
  IS_OWNER: "The owner's role doesn't change here.",
  INVALID_PHONE: "That phone number could not be read. Ask for the full number.",
  PHONE_IN_USE: "That phone number already belongs to someone else.",
  MEMBER_NOT_FOUND: "No member has that id. Check read_business for the members.",
  ITEM_NOT_FOUND: "No pricebook item has that id. Check read_business.",
  NAME_TAKEN: "Another pricebook item already has that name.",
  RULE_NOT_FOUND: "No rule has that id. Check read_business.",
  QUOTE_NOT_FOUND: "No quote has that id. Use list_quotes to find it.",
  NO_QUOTES: "That customer has no quotes to repeat. Say so in one line and offer to quote the job new.",
  QUOTE_CLOSED: "That quote is closed (won, lost, or void) and cannot change.",
  QUOTE_NOT_OPEN: "That quote is not a draft anymore.",
  NOT_APPROVED: "That quote has not been approved yet.",
  NOT_READY: "That quote still needs prices or quantities before it can be approved, so it can't be marked sent.",
  NO_LINES: "A quote needs at least one line.",
  TITLE_REQUIRED: "A quote needs a title, such as the address or the member's name for the job.",
  NAME_REQUIRED: "A new customer needs a name.",
  CUSTOMER_NOT_FOUND: "No customer has that id. Use find_customer.",
  PROPERTY_NOT_FOUND: "No property has that id.",
  CUSTOMER_ARCHIVED: "That customer is archived. Use find_customer for the current one; an owner or admin can restore it on the customer's page.",
  CUSTOMER_MERGED: "That customer was merged into another. Use find_customer for the one it became.",
  SAME_CUSTOMER: "Those are the same customer. Find the duplicate with find_customer.",
  CONTACT_NOT_FOUND: "That contact isn't on this customer. Use find_customer for its contacts and their ids.",
  CONTACT_NAME_REQUIRED: "A new contact needs a name. Ask who they are.",
  REVISION_CHANGED: "Someone changed this since it was read. Read it again, then make the change.",
  NOTE_NOT_FOUND: "No note this member can see has that id. Use search_records or read_business.",
  NOTE_TITLE_REQUIRED: "A new note needs a short title, like \"Gate code\" or \"Warranty terms\".",
  NOTE_BUSINESS_PRIVILEGED: "Only the owner or an admin saves notes on how the whole business works. Tell the member in one line to ask them; crew can put a note on a customer or quote they work on.",
  NOTE_NOT_YOURS: "Crew change only notes they wrote. The owner or an admin can change this one.",
  NO_TEXTED_FILE: "There's no file on the member's recent texts to keep. Ask them to send it again.",
  NO_TEXTED_IMAGE: "There's no photo or image on the member's recent texts. Ask them to text the logo, a PNG or JPEG (a screenshot works).",
  NO_ATTACHED_IMAGE: "There's no image attached in this conversation. Ask them to attach the logo with the paperclip, a PNG or JPEG (a screenshot works).",
  LOGO_UNSUPPORTED: "That file can't be used as a logo: only PNG and JPEG work (iPhone photos too), not WebP, GIF, or SVG. Ask for a PNG or JPEG; a screenshot of the logo works.",
  LOGO_TOO_LARGE: "That image is too big for a logo (over 5 MB, or too many pixels). Ask for a smaller PNG or JPEG.",
  LOGO_TOO_SMALL: "That image is too small to print as a logo. Ask for a bigger one.",
  LOGO_ANIMATED: "That image is animated. Ask for a still PNG or JPEG.",
  LOGO_UNREADABLE: "That image couldn't be opened. Ask them to send it again as a PNG or JPEG.",
  PHOTO_NOT_FOUND: "That photo isn't on this quote. Use get_quote for its attachments and their ids.",
  SAM_FAILED: "The photo couldn't be priced just now. Say so in one line; the quote itself is fine, and the photo can be priced again from the quote's page.",
  TOO_MANY_PHOTOS: "That work already has as many photos as it can hold. Say so in one line: some can be taken off on its page.",
  PROPERTY_MISMATCH: "That property belongs to a different customer.",
  LINE_NEEDS_ITEM_OR_NAME: "Each line needs an itemId from the pricebook or a name.",
  INVALID_QUANTITY: "Each line needs a numeric quantity.",
  INVALID_PRICE: "Prices are whole cents of zero or more.",
  INVALID_ADJUSTMENT: "Adjustments are whole cents of zero or more.",
  INVALID_ITEM_NAME: "An item needs a name.",
  INVALID_DAYS: "Follow-up days must be a whole number from 1 to 60.",
  NO_EMAIL: "The customer has no email saved. Ask the member for it.",
  INVALID_EMAIL: "That isn't an email address. Ask the member for it again.",
  EMAIL_NOT_CONFIGURED: "Email isn't set up for this business yet. Tell the member to forward the PDF for now.",
  EMAIL_REJECTED: "The email service refused that address. Ask the member to check it.",
  EMAIL_FAILED: "The email didn't go out. Say so, and suggest forwarding the PDF instead.",
  JOB_IN_JOB: "This conversation is already a job. Do the work here; jobs are opened from the member's thread.",
  JOB_NOT_FOUND: "No open job of this member has that id. Use list_jobs.",
  JOB_ARCHIVED: "That job is archived. Open a new job instead.",
  JOB_SESSION_FAILED: "The job couldn't start. Say so in one line; don't retry on your own.",
  MESSAGE_REQUIRED: "Pass the member's message.",
  CREW_REQUIRED: "A visit needs at least one crew member: pass memberIds from read_business. Ask who goes if they didn't say.",
  INVALID_HOURS: "Those hours can't be read. Each day needs a start before its end, in 24-hour HH:MM, and a day's stretches can't overlap.",
  INVALID_DATE: "That day can't be read. Pass YYYY-MM-DD, today, tomorrow, or a weekday name.",
  INVALID_TIME: "That time can't be read. Pass 24-hour HH:MM, like 09:00 or 14:30.",
  NONEXISTENT_TIME: "The clocks change then, so that time doesn't exist that day. Ask for another time.",
  AMBIGUOUS_TIME: "The clocks go back then, so that time happens twice. Ask which one, then pass its offsetMinutes.",
  INVALID_DURATION: "A visit lasts 15 minutes to 16 hours, in whole minutes.",
  INVALID_BUFFER: "Buffers are whole minutes from 0 to 480.",
  VISIT_NOT_FOUND: "No visit this member can see has that id. Use read_schedule.",
  VISIT_NOT_OPEN: "That visit is already done or cancelled, so it can't change. Book a new visit instead.",
  VISIT_NOT_PROPOSED: "That visit is already booked; only a pencilled-in one gets confirmed.",
  VISIT_NOT_STARTED: "That visit's day hasn't come yet, so it can't be marked done.",
  VISIT_IN_PAST: "That time has already passed. Ask for a time still to come.",
  OUTSIDE_HOURS: "That's outside the crew's working hours. Say whose hours and ask if they want it booked anyway; only if they say yes, pass allowOutsideHours.",
  CREW_BUSY: "Someone on the crew already has a visit then. Say which, and offer another time (find_availability) or other crew.",
  CREW_OFF: "Someone on the crew is off then. Say so and offer another time (find_availability) or other crew.",
  QUOTE_NOT_AGREED: "Only an approved, sent, or won quote can be scheduled. If the customer said yes, mark it won with set_quote_outcome first.",
  JOB_CLOSED: "That work is already completed or cancelled. Open new work for more visits.",
  SERVICE_JOB_NOT_FOUND: "No work has that id. Use read_schedule or get_quote.",
  NO_CHECKLIST: "That work has no quote, so it has no checklist. Say so in one line; a visit is still marked done with change_visit_status.",
  CHECKLIST_ITEM_NOT_FOUND: "That work's checklist has no such item. Use read_checklist for its items.",
  JOB_TITLE_REQUIRED: "Work without a quote needs a title, such as the address or the member's words for it.",
  VISITS_AHEAD: "That work still has visits coming up. Say when, and ask whether to cancel them; only then pass cancelUpcomingVisits.",
  HAS_VISITS: "They have visits booked in that time. Say which; those need moving or cancelling first.",
  TIME_OFF_NOT_FOUND: "No time off this member can change has that id. Use read_schedule.",
  INVOICE_NOT_FOUND: "No invoice has that id or number. Use list_invoices.",
  INVOICE_NOT_DRAFT: "That invoice was already sent, so its lines are frozen. Void it and make a new one if it's wrong (only with no payments on it).",
  INVOICE_VOID: "That invoice is void.",
  INVOICE_PAID: "That invoice is already paid in full.",
  INVOICE_ZERO: "That invoice totals $0, so it isn't sent. Ask what to bill.",
  BELOW_PAID: "A deposit the customer paid on the quote is already on this invoice, and these lines come to less. Say how much is paid and ask what to bill; a refund is made in Stripe.",
  INVOICE_NOT_PRICED: "A line has no price. Ask the member for the amount; never make one up.",
  INVOICE_TITLE_REQUIRED: "An invoice from scratch needs a title, such as the address or the member's words for the work.",
  INVOICE_HAS_PAYMENTS: "That invoice has payments on it, so it can't be voided. Say so; a payment recorded by mistake comes off with remove_payment first.",
  INVOICE_REQUIRED: "Say which invoice: pass invoiceId, or the customer's name.",
  NO_OPEN_INVOICE: "That customer has no unpaid invoice. Use list_invoices, or make one with create_invoice first.",
  NEEDS_LINES: "That work has no quote to copy, so ask the member what to bill (the lines and prices), then pass lines.",
  JOB_CANCELLED: "That work was cancelled, so it isn't invoiced.",
  OVERPAYMENT: "That's more than the invoice's balance. Say the balance and ask them to check the amount.",
  INVALID_AMOUNT: "Amounts are whole cents above zero ($150 → 15000).",
  INVALID_METHOD: "Payment methods are cash, check, card, or other.",
  PAYMENT_NOT_FOUND: "No payment has that id. Use get_invoice for its payments.",
  INVOICE_NO_WORK: "That invoice bills no work, so it has no work photos. Photos go on work with attach_work_photos.",
  INVOICE_PHOTO_NOT_FOUND: "That photo isn't on the invoice's work. Use get_invoice for its photos and their ids.",
  INVOICE_PHOTO_LIMIT: "At most 8 photos go on an invoice. Ask which 8.",
  PAGE_VERSION_NOT_FOUND: "That page has no such version. Say so in one line; the newest is the one to publish.",
  TEMPLATE_INVALID: "The page didn't pass the checks, so nothing was saved. Fix every problem listed and write or edit it again.",
  PAGE_NOT_DESIGNED: "That page has no design yet. Write the whole page with write_customer_page.",
  PAGE_EDIT_FAILED: "No edit was saved. Call read_customer_page for the template as it stands, then edit again.",
  NOT_A_WEBSITE: "That isn't a public website's address, so it wasn't opened. Ask for the site's address, like example.com.",
  STRIPE_PAYMENT: "That was a card payment through the pay link. It's refunded in Stripe, not removed here.",
  GLOSSARY_INVALID: "A glossary term needs the English word and the Spanish one, each on one line. Ask for whichever is missing.",
  GLOSSARY_FULL: "The glossary is full (200 terms). Say so; an owner or admin can remove terms on the Settings page.",
  GLOSSARY_TERM_NOT_FOUND: "That term isn't in the glossary. The glossary is in read_business.",
};

/** What a tool returns instead of throwing, as the demo tools do. */
export function toolError(error: unknown): { error: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(":")[0];
  const hint = HINTS[code] ?? (code === "UNKNOWN_ITEM" ? "That item id is not an active pricebook item." : code === "UNKNOWN_RULE" ? "That rule id is not an active rule." : undefined);
  return { error: hint ? `${message}: ${hint}` : message };
}

/** Tool outputs must be JSON: dates become ISO strings. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type InboundRef = {
  id: string;
  threadId: string | null;
  providerMessageId: string | null;
  kind: string;
  /** For a tapback, the Photon id of the message it is on. */
  targetProviderMessageId: string | null;
  createdAt: Date;
};

/**
 * The member's newest inbound message in the last 15 minutes: what this turn is answering.
 * Texts only by default; pass `["user", "reaction"]` to include tapbacks.
 */
export async function latestInbound(
  orgId: string,
  memberId: string,
  kinds: Array<"user" | "reaction"> = ["user"],
  now: Date = new Date(),
): Promise<InboundRef | null> {
  const [row] = await db()
    .select({
      id: messages.id,
      threadId: messages.threadId,
      providerMessageId: messages.providerMessageId,
      kind: messages.kind,
      targetProviderMessageId: messages.targetProviderMessageId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.memberId, memberId),
        eq(messages.direction, "inbound"),
        inArray(messages.kind, kinds),
        gte(messages.createdAt, new Date(now.getTime() - 15 * 60 * 1000)),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ?? null;
}

/** A quote as tools return it: the summary plus the text to send as the reply. */
export function withSummaryText<T extends QuoteSummary>(summary: T, caller: Caller): T & { summaryText: string } {
  return plain({ ...summary, summaryText: quoteSummaryText(summary, caller.language, caller.role) });
}
