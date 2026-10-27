import { randomUUID } from "node:crypto";
import { addPhone, createMember, recordInbound, type Caller } from "../../../core/members";
import { upsertThread } from "../../../core/conversations";
import { createBusinessInbox } from "../../../core/email-intake";
import { createAdapter } from "../../../core/imessage";
import { createOrganization } from "../../../core/organizations";
import { saveItems } from "../../../core/pricebook";
import { updateProfile } from "../../../core/profile";
import { saveCustomer, searchCustomers } from "../../../core/customers";
import { saveNote } from "../../../core/notes";
import { createInvoice, recordPayment, sendInvoice } from "../../../core/invoices";
import { approveQuote, createQuote, setQuoteOutcome, type QuoteSummary } from "../../../core/quotes";
import { bookVisit, createServiceJob } from "../../../core/scheduling";
import { resolveLocalTime, wallClock } from "../../../core/scheduling-time";
import { addDays } from "../../../core/time";
import { confirmedEmailForTests, truncateAll } from "../../../core/test-db";
import { LIMIT_BOUNDS, setUsageLimits } from "../../../core/usage-limits";

/**
 * Obviously fake. The only business in the database, so its owner is the one the local-dev principal
 * resolves to (the first active owner of the oldest business).
 */
const OWNER_NAME = "Sam Example";
const BUSINESS_NAME = "Example Services Co";

export const WINDOWS = "Windows, in and out";
export const SCREENS = "Screens";

export type SeededBusiness = {
  orgId: string;
  owner: Caller;
  itemIds: { windows: string; screens: string } | null;
};

/** Never texts anyone: a draft seeded for an eval must not try to post a PDF. */
const noPost = async () => ({ posted: false as const, reason: "eval" });

async function seedBase(): Promise<Caller> {
  await truncateAll();
  const org = await createOrganization({ name: BUSINESS_NAME });
  const owner = await createMember({ orgId: org.id, name: OWNER_NAME, role: "owner" });
  await updateProfile(org.id, { name: BUSINESS_NAME }, owner.id);
  // Evals measure the assistant, not the usage limits: the eval business gets the highest ones.
  await setUsageLimits(
    org.id,
    { hourlyTurns: LIMIT_BOUNDS.hourlyTurns.max, hourlyOutputTokens: LIMIT_BOUNDS.hourlyOutputTokens.max, concurrentTurns: LIMIT_BOUNDS.concurrentTurns.max },
    "evals",
  );
  return { orgId: org.id, memberId: owner.id, name: owner.name, role: "owner", language: "en", phoneE164: null };
}

/** Profile and one owner; no items and no minimum. */
export async function seedEmptyBusiness(): Promise<SeededBusiness> {
  const owner = await seedBase();
  return { orgId: owner.orgId, owner, itemIds: null };
}

/** The owner plus saved prices: windows $12 each, screens $2 each, minimum $150. */
export async function seedPricedBusiness(): Promise<SeededBusiness> {
  const owner = await seedBase();
  const [windows, screens] = await saveItems(
    owner.orgId,
    [
      { name: WINDOWS, unitKind: "each", unitLabel: "window", priceCents: 1200 },
      { name: SCREENS, unitKind: "each", unitLabel: "screen", priceCents: 200 },
    ],
    owner.memberId,
  );
  await updateProfile(owner.orgId, { minimumChargeCents: 15000 }, owner.memberId);
  return { orgId: owner.orgId, owner, itemIds: { windows: windows.id, screens: screens.id } };
}

/** The owner and one saved price, Gadget fitting $3 each, that a price sheet will change. No minimum. */
export async function seedOneItemBusiness(): Promise<SeededBusiness & { gadgetId: string }> {
  const owner = await seedBase();
  const [gadget] = await saveItems(
    owner.orgId,
    [{ name: "Gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 300 }],
    owner.memberId,
  );
  return { orgId: owner.orgId, owner, itemIds: null, gadgetId: gadget.id };
}

/** A draft quote of `windowCount` windows, created through the same repository the tool uses. */
export async function seedDraftQuote(
  business: SeededBusiness,
  input: { title: string; windowCount: number },
): Promise<QuoteSummary> {
  if (!business.itemIds) throw new Error("seedDraftQuote needs the priced business");
  return createQuote(
    { title: input.title, lines: [{ itemId: business.itemIds.windows, quantity: input.windowCount }] },
    business.owner,
    { post: noPost },
  );
}

export type ScheduledBusiness = SeededBusiness & {
  timeZone: string;
  crew: { carlos: Caller; ana: Caller };
  /** Approved, for a customer who says yes in the eval. */
  oakSt: QuoteSummary;
};

async function crewMember(orgId: string, name: string, addedBy: string): Promise<Caller> {
  const member = await createMember({ orgId, name, role: "member", addedByMemberId: addedBy });
  return { orgId, memberId: member.id, name, role: "member", language: "en", phoneE164: null };
}

/** The priced business with two crew, Carlos and Ana, and an approved quote for 12 Oak St. */
export async function seedScheduledBusiness(): Promise<ScheduledBusiness> {
  const business = await seedPricedBusiness();
  const { owner } = business;
  const carlos = await crewMember(owner.orgId, "Carlos Example", owner.memberId);
  const ana = await crewMember(owner.orgId, "Ana Example", owner.memberId);
  const customer = await saveCustomer(owner.orgId, { name: "Ada Sample", address: "12 Oak St" }, owner.memberId);
  const draft = await createQuote(
    {
      title: "12 Oak St",
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      lines: [{ itemId: business.itemIds!.windows, quantity: 20 }],
    },
    owner,
    { post: noPost },
  );
  await approveQuote(draft.quoteId, owner, { post: noPost });
  return { ...business, timeZone: "America/New_York", crew: { carlos, ana }, oakSt: draft };
}

/**
 * Today's visits, booked as of this morning: Carlos at 12 Oak St at 9, Ana at 4 Elm Rd at 1, and
 * Carlos again tomorrow at 7 Pine Ave. Outside working hours is fine: the eval may run on a weekend.
 */
export async function seedTodaysVisits(business: ScheduledBusiness): Promise<void> {
  const { owner } = business;
  const today = wallClock(new Date(), business.timeZone).date;
  const morning = { now: resolveLocalTime(today, "00:30", business.timeZone), post: noPost };
  const book = (title: string, memberId: string, day: string, time: string) =>
    bookVisit(owner, { title, memberIds: [memberId], day, time, allowOutsideHours: true }, morning);
  await bookVisit(owner, { quoteId: business.oakSt.quoteId, memberIds: [business.crew.carlos.memberId], day: today, time: "09:00", allowOutsideHours: true }, morning);
  await book("4 Elm Rd", business.crew.ana.memberId, today, "13:00");
  await book("7 Pine Ave", business.crew.carlos.memberId, addDays(today, 1), "09:00");
}

/** The scheduled business with 12 Oak St won and its work open, not yet invoiced: "it's done, invoice it". */
export async function seedWorkToInvoice(): Promise<ScheduledBusiness & { jobId: string }> {
  const business = await seedScheduledBusiness();
  await setQuoteOutcome(business.oakSt.quoteId, "won", business.owner, { post: noPost });
  const { job } = await createServiceJob(business.owner, { quoteId: business.oakSt.quoteId });
  return { ...business, jobId: job.id };
}

export type BilledBusiness = SeededBusiness & { jane: { invoiceId: string; totalCents: number }; bo: { invoiceId: string; totalCents: number } };

/**
 * The priced business with three sent invoices: Jane Sample $240 (20 windows, unpaid), Bo Example $420
 * (30 windows and 30 screens, sent three weeks ago on net 15, so overdue), and Cy Sample $168, paid.
 */
export async function seedInvoices(): Promise<BilledBusiness> {
  const business = await seedPricedBusiness();
  const { owner } = business;
  const { windows, screens } = business.itemIds!;
  await updateProfile(owner.orgId, { paymentTermsDays: 15 }, owner.memberId);
  const bill = async (name: string, address: string, lines: Array<{ itemId: string; quantity: number }>, sentAt: Date) => {
    const customer = await saveCustomer(owner.orgId, { name, address }, owner.memberId);
    const { invoice } = await createInvoice(owner, { title: address, customerId: customer.id, propertyId: customer.properties[0].id, lines });
    await sendInvoice(owner, invoice.id, { post: noPost, now: sentAt });
    return { invoiceId: invoice.id, totalCents: invoice.totalCents };
  };
  const now = Date.now();
  const jane = await bill("Jane Sample", "12 Oak St", [{ itemId: windows, quantity: 20 }], new Date(now - 2 * 86_400_000));
  const bo = await bill("Bo Example", "4 Elm Rd", [{ itemId: windows, quantity: 30 }, { itemId: screens, quantity: 30 }], new Date(now - 21 * 86_400_000));
  const cy = await bill("Cy Sample", "7 Pine Ave", [{ itemId: windows, quantity: 14 }], new Date(now - 10 * 86_400_000));
  await recordPayment(owner, { invoiceId: cy.invoiceId, amountCents: cy.totalCents, method: "check" });
  return { ...business, jane, bo };
}

/** The scheduled business with a site note on Ada Sample's 12 Oak St: its gate code, 4821. */
export async function seedSiteNote(): Promise<ScheduledBusiness & { noteId: string }> {
  const business = await seedScheduledBusiness();
  const [ada] = await searchCustomers(business.orgId, "Ada Sample");
  const note = await saveNote(business.owner, {
    title: "Gate code",
    body: "Gate code is 4821. The latch sticks, lift it.",
    propertyId: ada.properties[0].id,
    tags: ["access"],
  });
  return { ...business, noteId: note.id };
}

export type DuplicateCustomers = SeededBusiness & { jane: { id: string; quoteId: string }; j: { id: string; quoteId: string } };

/** The priced business with the same person saved twice: Jane Smith at 12 Oak St and J. Smith by email, a draft each. */
export async function seedDuplicateCustomers(): Promise<DuplicateCustomers> {
  const business = await seedPricedBusiness();
  const { owner } = business;
  const jane = await saveCustomer(owner.orgId, { name: "Jane Smith", phone: "305 555 0190", address: "12 Oak St" }, owner.memberId);
  const j = await saveCustomer(owner.orgId, { name: "J. Smith", email: "jsmith@example.test" }, owner.memberId);
  const quote = (customerId: string, title: string, windowCount: number) =>
    createQuote({ title, customerId, lines: [{ itemId: business.itemIds!.windows, quantity: windowCount }] }, owner, { post: noPost });
  const janeQuote = await quote(jane.id, "12 Oak St", 20);
  const jQuote = await quote(j.id, "J. Smith windows", 12);
  return { ...business, jane: { id: jane.id, quoteId: janeQuote.quoteId }, j: { id: j.id, quoteId: jQuote.quoteId } };
}

export type EmailBusiness = SeededBusiness & {
  inbox: { inboxId: string; address: string };
  ownerEmail: string;
  ownerThreadId: string;
};

/**
 * The priced business, with the owner texting from a phone (their iMessage thread, where a forwarded
 * email's turn runs), forwarding from pat@example.com, and the business's fake inbox. No quiet hours, so
 * the summary is texted whenever the eval runs.
 */
export async function seedEmailBusiness(): Promise<EmailBusiness> {
  const business = await seedPricedBusiness();
  const { owner } = business;
  const phone = "+15555550142";
  const row = await addPhone(owner.orgId, owner.memberId, phone);
  // The fake adapter's thread id for the owner's chat with the line, as their first text would set it. A new
  // chat each run: eve dev keeps a thread's session between runs, and an old run's would be picked up.
  const ownerThreadId = createAdapter().encodeThreadId({ chatGuid: `any;-;eval-${randomUUID()}@example.com`, phone: "+15555550100" });
  await recordInbound(owner.orgId, row.id, ownerThreadId, new Date(Date.now() - 60_000), "iMessage");
  // Their thread with the assistant, which that first text opened: each forwarded email's thread hangs off it.
  // The emails run in threads of their own, so the session here is never used.
  await upsertThread(owner.orgId, owner.memberId, `ses_eval_${randomUUID()}`);
  await updateProfile(owner.orgId, { quietStartHour: 0, quietEndHour: 0 }, owner.memberId);
  const ownerEmail = "pat@example.com";
  // Confirmed, as if the owner had emailed the inbox its code.
  await confirmedEmailForTests(owner.orgId, owner.memberId, ownerEmail);
  const inbox = await createBusinessInbox(owner.orgId);
  return { ...business, owner: { ...owner, phoneE164: phone }, inbox, ownerEmail, ownerThreadId };
}
