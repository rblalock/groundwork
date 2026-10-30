// Invoices and payments: a bill for a completed job or an agreed quote (its lines copied from the agreed
// revision), or written from scratch; then the money received against it, recorded by a member or paid
// through its pay link (Stripe). Every amount comes from `calculate`, in integer cents, like quotes.
//
// The rules, which the tools and the web pages both go through:
// - Owners and admins only. Crew never see business-wide money (`NOT_PRIVILEGED`).
// - One invoice per job and per quote, unless voided: asking again returns the first one.
// - A draft's lines are editable; sending issues it (the issue date is today in the business's time
//   zone, due `payment_terms_days` later, 0 meaning due on receipt) and freezes them.
// - No $0 invoice is sent, and a line needs a price: amounts are never made up.
// - A payment can't be more than the balance (`OVERPAYMENT`). A payment recorded on a draft issues it.
//   A card payment through Stripe is recorded as Stripe took it, even when it's more than was owed,
//   since the money moved; the owner is told to refund the difference in Stripe.
// - A void needs no payments on it: take a mistaken manual payment off first. A Stripe payment is
//   refunded in Stripe, not removed here; the refund comes back by webhook (`recordStripeRefund`) and
//   takes the payment down by what was refunded, or off once it's all refunded.
// - Overdue: sent or partly paid, and its due date is before today in the business's time zone.
// - Photos of its work go on its PDF only as an owner or admin picks them (`setInvoicePhotos`), any time
//   before it's void; none by default.
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import {
  businessProfile,
  customers,
  invoices,
  members,
  payments,
  pricebookItems,
  properties,
  quoteRevisions,
  quotes,
  serviceJobs,
} from "../schema/schema";
import { appOrigin } from "./app-url";
import { beforeAfterFor, renderBeforeAfter } from "./before-after";
import { deleteBlob, readStoredFile, storeInvoicePdf } from "./blob";
import { calculate, type Adjustment, type LineInput, type LineResult, type RuleLine } from "./calculator";
import { getCustomer } from "./customers";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import { isLanguage, type Language } from "./language";
import { isPrivileged, memberPhoneService, type Caller } from "./members";
import { formatCents } from "./money";
import { postToMember } from "./outbound";
import { loadLogo } from "./branding";
import { invoicePdfFileName, receiptPdfFileName, renderInvoicePdf, renderReceiptPdf, type QuotePdfPhoto } from "./pdf";
import { getProfileWith, type Profile } from "./profile";
import type { Poster } from "./quotes";
import { takesCardPayments } from "./stripe-connection";
import { addDays, todayYmd } from "./time";
import { listWorkPhotos, type WorkPhotoView } from "./work-photos";

export type Invoice = typeof invoices.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type InvoiceStatus = Invoice["status"];
export type PaymentMethod = Payment["method"];
/** What the lists filter by: a status, or `open` (sent or partly paid) and `overdue`. */
export type InvoiceFilter = InvoiceStatus | "open" | "overdue";

export const INVOICE_STATUSES = ["draft", "sent", "partially_paid", "paid", "void"] as const satisfies readonly InvoiceStatus[];
export const PAYMENT_METHODS = ["cash", "check", "card", "other"] as const satisfies readonly PaymentMethod[];
const OPEN: InvoiceStatus[] = ["sent", "partially_paid"];
const AGREED_QUOTE = ["approved", "sent", "won"];

/** Who acts on an invoice: a member of the business. Only owners and admins get past `requirePrivileged`. */
export type InvoiceActor = Pick<Caller, "orgId" | "memberId" | "role" | "name" | "language"> & { phoneE164?: string | null };

export type InvoiceLineInput = {
  /** A pricebook item: its saved name, unit, and price unless the line gives its own price. */
  itemId?: string;
  name?: string;
  unitLabel?: string;
  quantity: number;
  unitCents?: number;
  taxable?: boolean;
};

export type PaymentView = Payment & { recordedBy: string | null };

export type InvoiceView = Invoice & {
  /** "INV-0001". */
  label: string;
  customerName: string | null;
  address: string | null;
  balanceCents: number;
  /** More than the total came in (a card payment for an old balance). */
  overpaidCents: number;
  overdue: boolean;
  daysOverdue: number;
  /** The link the customer pays at; null unless it's issued, owes something, and the business takes cards. */
  payUrl: string | null;
  createdBy: string;
};

export type InvoiceDetail = InvoiceView & { payments: PaymentView[] };

type Deps = { now?: Date; post?: Poster };

// ---------------------------------------------------------------------------------------------
// Small pieces

export const invoiceLabel = (number: number) => `INV-${String(number).padStart(4, "0")}`;

function requirePrivileged(actor: Pick<InvoiceActor, "role">): void {
  if (!isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
}

const balanceOf = (invoice: Pick<Invoice, "totalCents" | "amountPaidCents">) => Math.max(0, invoice.totalCents - invoice.amountPaidCents);

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function isOverdue(invoice: Pick<Invoice, "status" | "dueDate">, today: string): boolean {
  return OPEN.includes(invoice.status) && invoice.dueDate !== null && invoice.dueDate < today;
}

/** The status money moves an issued invoice to. */
function paidStatus(totalCents: number, paidCents: number): InvoiceStatus {
  if (paidCents <= 0) return "sent";
  return paidCents >= totalCents ? "paid" : "partially_paid";
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(value: string): string {
  if (!YMD.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("INVALID_DATE");
  }
  return value;
}

/** Totals for an invoice's lines, through the quotes' calculator. The quote's extras ride along as fixed amounts. */
function totalsFor(input: { lines: LineInput[]; ruleLines: RuleLine[]; minimumCents: number | null; adjustments: Adjustment[]; taxRateBp: number | null }) {
  if (input.lines.length === 0) throw new Error("NO_LINES");
  const calc = calculate({
    lines: input.lines,
    rules: input.ruleLines.map((r) => ({ ruleId: r.ruleId, text: r.label, effect: { op: "add_fixed", amount: r.cents, appliesTo: "any" } })),
    minimumCents: input.minimumCents,
    adjustments: input.adjustments,
    taxRateBp: input.taxRateBp,
  });
  if (calc.state !== "ready") throw new Error(`INVOICE_NOT_PRICED: ${calc.reasons.join(", ")}`);
  return calc;
}

function toLineInput(line: LineResult): LineInput {
  const { totalCents: _totalCents, ...input } = line;
  return input;
}

/** Lines written for the invoice: a pricebook item's price unless the line states its own; otherwise a name and a price. */
async function resolveLines(orgId: string, lines: InvoiceLineInput[], executor: Db | Tx): Promise<LineInput[]> {
  if (lines.length === 0) throw new Error("NO_LINES");
  const ids = [...new Set(lines.map((l) => l.itemId).filter((id): id is string => Boolean(id)))];
  const rows = ids.length
    ? await executor
        .select()
        .from(pricebookItems)
        .where(and(eq(pricebookItems.orgId, orgId), inArray(pricebookItems.id, ids), eq(pricebookItems.status, "active")))
    : [];
  const items = new Map(rows.map((r) => [r.id, r]));
  return lines.map((line) => {
    if (typeof line.quantity !== "number" || !Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error("INVALID_QUANTITY");
    if (line.unitCents !== undefined && (!Number.isSafeInteger(line.unitCents) || line.unitCents < 0)) throw new Error("INVALID_PRICE");
    if (line.itemId) {
      const item = items.get(line.itemId);
      if (!item) throw new Error(`UNKNOWN_ITEM:${line.itemId}`);
      const overridden = line.unitCents !== undefined && line.unitCents !== item.priceCents;
      return {
        itemId: item.id,
        name: line.name?.trim() || item.name,
        unitLabel: line.unitLabel?.trim() ?? item.unitLabel,
        quantity: line.quantity,
        unitCents: overridden ? (line.unitCents as number) : item.priceCents,
        taxable: line.taxable ?? item.taxable,
        source: overridden ? "override" : "pricebook",
      };
    }
    const name = line.name?.trim();
    if (!name) throw new Error("LINE_NEEDS_ITEM_OR_NAME");
    if (line.unitCents === undefined) throw new Error(`INVOICE_NOT_PRICED: unpriced:${name}`);
    return {
      itemId: null,
      name,
      unitLabel: line.unitLabel?.trim() ?? "",
      quantity: line.quantity,
      unitCents: line.unitCents,
      taxable: line.taxable ?? true,
      source: "override",
    };
  });
}

/**
 * Takes the business's next invoice number. The counter row's lock holds until the transaction ends, so
 * two invoices made at once get different numbers, and a rolled-back one gives its number back.
 */
export async function takeInvoiceNumber(executor: Db | Tx, orgId: string): Promise<number> {
  await getProfileWith(orgId, executor);
  const [row] = await executor
    .update(businessProfile)
    .set({ nextInvoiceNumber: sql`${businessProfile.nextInvoiceNumber} + 1` })
    .where(eq(businessProfile.orgId, orgId))
    .returning({ next: businessProfile.nextInvoiceNumber });
  return row.next - 1;
}

async function lockInvoice(tx: Tx, orgId: string, invoiceId: string): Promise<Invoice> {
  const [row] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)))
    .for("update");
  if (!row) throw new Error("INVOICE_NOT_FOUND");
  return row;
}

// ---------------------------------------------------------------------------------------------
// Reading

type Row = { invoice: Invoice; customerName: string | null; address: string | null; createdBy: string };

function viewQuery(orgId: string, executor: Db | Tx = db()) {
  return executor
    .select({ invoice: invoices, customerName: customers.name, address: properties.address, createdBy: members.name })
    .from(invoices)
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, invoices.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, invoices.propertyId)))
    .innerJoin(members, and(eq(members.orgId, orgId), eq(members.id, invoices.createdByMemberId)));
}

function toView(row: Row, today: string, cards: boolean): InvoiceView {
  const { invoice } = row;
  const balanceCents = balanceOf(invoice);
  const overdue = isOverdue(invoice, today);
  return {
    ...invoice,
    label: invoiceLabel(invoice.number),
    customerName: row.customerName,
    address: row.address,
    balanceCents,
    overpaidCents: Math.max(0, invoice.amountPaidCents - invoice.totalCents),
    overdue,
    daysOverdue: overdue && invoice.dueDate ? daysBetween(invoice.dueDate, today) : 0,
    payUrl: cards && OPEN.includes(invoice.status) && balanceCents > 0 ? payUrlFor(invoice.payToken) : null,
    createdBy: row.createdBy,
  };
}

export const payUrlFor = (token: string) => `${appOrigin()}/pay/${token}`;

async function context(orgId: string, now: Date): Promise<{ profile: Profile; today: string; cards: boolean }> {
  const profile = await getProfileWith(orgId, db());
  return { profile, today: todayYmd(profile.timeZone, now), cards: await takesCardPayments(orgId) };
}

export async function getInvoice(orgId: string, invoiceId: string, deps?: { now?: Date }): Promise<InvoiceDetail | null> {
  const { today, cards } = await context(orgId, deps?.now ?? new Date());
  const [row] = await viewQuery(orgId).where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
  if (!row) return null;
  const paymentRows = await db()
    .select({ payment: payments, recordedBy: members.name })
    .from(payments)
    .leftJoin(members, and(eq(members.orgId, orgId), eq(members.id, payments.recordedByMemberId)))
    .where(and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoiceId)))
    .orderBy(asc(payments.createdAt), asc(payments.id));
  return { ...toView(row, today, cards), payments: paymentRows.map(({ payment, recordedBy }) => ({ ...payment, recordedBy })) };
}

/**
 * The invoice a member means: its id, or its number as they'd say it ("INV-0003", "invoice 3", "3").
 * Null when it isn't this business's.
 */
export async function resolveInvoiceId(orgId: string, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  const number = /^(?:inv(?:oice)?[\s#-]*)?0*(\d{1,7})$/i.exec(trimmed)?.[1];
  const [row] = await db()
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), number ? or(eq(invoices.id, trimmed), eq(invoices.number, Number(number))) : eq(invoices.id, trimmed)));
  return row?.id ?? null;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

function filterCondition(filter: InvoiceFilter | undefined, today: string): SQL | undefined {
  if (!filter) return undefined;
  if (filter === "open") return inArray(invoices.status, OPEN);
  if (filter === "overdue") return and(inArray(invoices.status, OPEN), lt(invoices.dueDate, today));
  return eq(invoices.status, filter);
}

/** Invoices, newest first. `query` matches the title, the customer, the address, or the number. */
/**
 * The business's invoices, newest number first. `before` and `after` page by number (keyset, so an
 * invoice that changes never moves between pages): `before` lists the ones older than that number,
 * `after` the ones just newer, still newest first.
 */
export async function listInvoices(
  orgId: string,
  filter: { status?: InvoiceFilter; customerId?: string; query?: string; limit?: number; before?: number; after?: number } = {},
  deps?: { now?: Date },
): Promise<InvoiceView[]> {
  const { today, cards } = await context(orgId, deps?.now ?? new Date());
  const conditions: SQL[] = [eq(invoices.orgId, orgId)];
  const byStatus = filterCondition(filter.status, today);
  if (byStatus) conditions.push(byStatus);
  if (filter.customerId) conditions.push(eq(invoices.customerId, filter.customerId));
  for (const token of (filter.query ?? "").trim().split(/\s+/).filter(Boolean)) {
    const pattern = `%${escapeLike(token)}%`;
    const number = /^(?:inv-?)?0*(\d{1,7})$/i.exec(token)?.[1];
    conditions.push(
      or(
        sql`${invoices.title} ilike ${pattern}`,
        sql`${customers.name} ilike ${pattern}`,
        sql`${properties.address} ilike ${pattern}`,
        ...(number ? [eq(invoices.number, Number(number))] : []),
      ) as SQL,
    );
  }
  if (filter.before !== undefined) conditions.push(lt(invoices.number, filter.before));
  if (filter.after !== undefined) conditions.push(gt(invoices.number, filter.after));
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 100);
  const newer = filter.after !== undefined && filter.before === undefined;
  const rows = await viewQuery(orgId)
    .where(and(...conditions))
    .orderBy(newer ? asc(invoices.number) : desc(invoices.number))
    .limit(limit);
  if (newer) rows.reverse();
  return rows.map((row) => toView(row, today, cards));
}

export type InvoiceTotals = {
  counts: Record<InvoiceStatus | "open" | "overdue" | "all", number>;
  /** What sent and partly paid invoices still owe. */
  outstandingCents: number;
  overdueCents: number;
};

export async function invoiceTotals(orgId: string, deps?: { now?: Date }): Promise<InvoiceTotals> {
  const { today } = await context(orgId, deps?.now ?? new Date());
  const rows = await db()
    .select({ status: invoices.status, dueDate: invoices.dueDate, total: invoices.totalCents, paid: invoices.amountPaidCents })
    .from(invoices)
    .where(eq(invoices.orgId, orgId));
  const counts = { draft: 0, sent: 0, partially_paid: 0, paid: 0, void: 0, open: 0, overdue: 0, all: rows.length };
  let outstandingCents = 0;
  let overdueCents = 0;
  for (const row of rows) {
    counts[row.status]++;
    if (!OPEN.includes(row.status)) continue;
    const balance = Math.max(0, row.total - row.paid);
    counts.open++;
    outstandingCents += balance;
    if (isOverdue(row, today)) {
      counts.overdue++;
      overdueCents += balance;
    }
  }
  return { counts, outstandingCents, overdueCents };
}

export type CustomerBalance = {
  customerId: string | null;
  /** The customer's name, or the invoice's title when it has no customer. */
  name: string;
  balanceCents: number;
  overdueCents: number;
  invoices: Array<{ invoiceId: string; label: string; title: string; balanceCents: number; dueDate: string | null; overdue: boolean; daysOverdue: number }>;
};

/** Who owes the business, most first: open invoices grouped by customer (each one alone when it has none). */
export async function balancesByCustomer(orgId: string, deps?: { now?: Date }): Promise<CustomerBalance[]> {
  const open = await listInvoices(orgId, { status: "open", limit: 100 }, deps);
  const groups = new Map<string, CustomerBalance>();
  for (const invoice of open) {
    if (invoice.balanceCents <= 0) continue;
    const key = invoice.customerId ?? `invoice:${invoice.id}`;
    const group = groups.get(key) ?? {
      customerId: invoice.customerId,
      name: invoice.customerName ?? invoice.title,
      balanceCents: 0,
      overdueCents: 0,
      invoices: [],
    };
    group.balanceCents += invoice.balanceCents;
    if (invoice.overdue) group.overdueCents += invoice.balanceCents;
    group.invoices.push({
      invoiceId: invoice.id,
      label: invoice.label,
      title: invoice.title,
      balanceCents: invoice.balanceCents,
      dueDate: invoice.dueDate,
      overdue: invoice.overdue,
      daysOverdue: invoice.daysOverdue,
    });
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.balanceCents - a.balanceCents || a.name.localeCompare(b.name));
}

/** What one customer owes, for their page. */
export async function customerBalance(orgId: string, customerId: string, deps?: { now?: Date }): Promise<{ balanceCents: number; overdueCents: number }> {
  const found = (await balancesByCustomer(orgId, deps)).find((b) => b.customerId === customerId);
  return { balanceCents: found?.balanceCents ?? 0, overdueCents: found?.overdueCents ?? 0 };
}

export type ReadyToInvoice = {
  jobId: string;
  title: string;
  customerName: string | null;
  address: string | null;
  quoteId: string | null;
  /** The agreed quote's total, when the work came from one. */
  quoteTotalCents: number | null;
  completedAt: Date | null;
};

/** Completed work with no invoice yet (none on the job, nor on its quote), oldest first. */
export async function readyToInvoice(orgId: string): Promise<ReadyToInvoice[]> {
  const notVoid = ne(invoices.status, "void");
  const rows = await db()
    .select({ job: serviceJobs, customerName: customers.name, address: properties.address, total: quoteRevisions.totalCents })
    .from(serviceJobs)
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, serviceJobs.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, serviceJobs.propertyId)))
    .leftJoin(quoteRevisions, and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, serviceJobs.quoteRevisionId)))
    .where(
      and(
        eq(serviceJobs.orgId, orgId),
        eq(serviceJobs.status, "completed"),
        notExists(
          db()
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(
                eq(invoices.orgId, orgId),
                notVoid,
                or(eq(invoices.serviceJobId, serviceJobs.id), and(sql`${serviceJobs.quoteId} is not null`, eq(invoices.quoteId, serviceJobs.quoteId))),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(serviceJobs.closedAt), asc(serviceJobs.id));
  return rows.map(({ job, customerName, address, total }) => ({
    jobId: job.id,
    title: job.title,
    customerName,
    address,
    quoteId: job.quoteId,
    quoteTotalCents: total ?? null,
    completedAt: job.closedAt,
  }));
}

export type InvoiceRef = { invoiceId: string; label: string; status: InvoiceStatus; balanceCents: number };

/** The invoice (not void) on each of these jobs, for the schedule's visit details. */
export async function invoicesForJobs(orgId: string, jobIds: string[]): Promise<Map<string, InvoiceRef>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db()
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), inArray(invoices.serviceJobId, jobIds), ne(invoices.status, "void")));
  return new Map(
    rows.map((r) => [r.serviceJobId as string, { invoiceId: r.id, label: invoiceLabel(r.number), status: r.status, balanceCents: balanceOf(r) }]),
  );
}

/** The invoice (not void) on a quote, if it has one. */
export async function invoiceForQuote(orgId: string, quoteId: string): Promise<InvoiceRef | null> {
  const [row] = await db()
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), eq(invoices.quoteId, quoteId), ne(invoices.status, "void")));
  return row ? { invoiceId: row.id, label: invoiceLabel(row.number), status: row.status, balanceCents: balanceOf(row) } : null;
}

/** `invoiceLabel` is null for a deposit not on an invoice yet; its title is then the quote's. */
export type PaymentRow = PaymentView & { invoiceLabel: string | null; invoiceTitle: string; customerName: string | null };

/** Where a page of payments starts or ends: one payment's day, when it was recorded (to the millisecond), and id. */
export type PaymentCursor = { date: string; at: string; id: string };

/** The cursor for a payment, as the Payments page passes it back to list the page after or before it. */
export function paymentCursor(payment: Pick<Payment, "receivedDate" | "createdAt" | "id">): PaymentCursor {
  return { date: payment.receivedDate, at: payment.createdAt.toISOString(), id: payment.id };
}

// Payments sort by the day they came in, then when they were recorded, then id. Recorded times are kept
// to the microsecond but a cursor carries milliseconds, so both sides compare at milliseconds.
const paymentKey = sql`(${payments.receivedDate}, date_trunc('milliseconds', ${payments.createdAt}), ${payments.id})`;
const cursorKey = (cursor: PaymentCursor) => sql`(${cursor.date}::date, ${cursor.at}::timestamptz, ${cursor.id})`;

/**
 * Payments received, newest first, with what they paid. Taken-back entries are left out. `before` and
 * `after` page by a payment's cursor (keyset, so pages never overlap or skip): `before` lists the older
 * ones, `after` the ones just newer, still newest first.
 */
export async function listPayments(
  orgId: string,
  filter: { limit?: number; before?: PaymentCursor; after?: PaymentCursor } = {},
): Promise<PaymentRow[]> {
  const newer = filter.after !== undefined && filter.before === undefined;
  const conditions: SQL[] = [eq(payments.orgId, orgId), isNull(payments.removedAt)];
  if (filter.before) conditions.push(sql`${paymentKey} < ${cursorKey(filter.before)}`);
  if (filter.after) conditions.push(sql`${paymentKey} > ${cursorKey(filter.after)}`);
  const order = newer
    ? [asc(payments.receivedDate), sql`date_trunc('milliseconds', ${payments.createdAt}) asc`, asc(payments.id)]
    : [desc(payments.receivedDate), sql`date_trunc('milliseconds', ${payments.createdAt}) desc`, desc(payments.id)];
  const rows = await db()
    .select({
      payment: payments,
      recordedBy: members.name,
      number: invoices.number,
      title: sql<string>`coalesce(${invoices.title}, ${quotes.title})`,
      customerName: customers.name,
    })
    .from(payments)
    .leftJoin(invoices, and(eq(invoices.orgId, orgId), eq(invoices.id, payments.invoiceId)))
    .leftJoin(quotes, and(eq(quotes.orgId, orgId), eq(quotes.id, payments.quoteId)))
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, sql`coalesce(${invoices.customerId}, ${quotes.customerId})`)))
    .leftJoin(members, and(eq(members.orgId, orgId), eq(members.id, payments.recordedByMemberId)))
    .where(and(...conditions))
    .orderBy(...order)
    .limit(Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200));
  if (newer) rows.reverse();
  return rows.map(({ payment, recordedBy, number, title, customerName }) => ({
    ...payment,
    recordedBy,
    invoiceLabel: number === null ? null : invoiceLabel(number),
    invoiceTitle: title,
    customerName,
  }));
}

/** Everything received, all told: the Payments page's total across every page. */
export async function paymentsReceivedCents(orgId: string): Promise<number> {
  const [row] = await db()
    .select({ total: sql<string>`coalesce(sum(${payments.amountCents}), 0)::bigint` })
    .from(payments)
    .where(and(eq(payments.orgId, orgId), isNull(payments.removedAt)));
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Making and editing

export type CreateInvoiceInput = {
  /** Completed (or open) work: its quote's agreed lines, or `lines` when it has no quote. */
  serviceJobId?: string;
  /** An approved, sent, or won quote: its current revision's lines. */
  quoteId?: string;
  customerId?: string;
  propertyId?: string;
  title?: string;
  /** Required without a job or quote, and for a job with no quote. */
  lines?: InvoiceLineInput[];
  notes?: string;
};

type Draft = {
  title: string;
  customerId: string | null;
  propertyId: string | null;
  serviceJobId: string | null;
  quoteId: string | null;
  quoteRevisionId: string | null;
  lines: LineInput[];
  ruleLines: RuleLine[];
  adjustments: Adjustment[];
  minimumCents: number | null;
  taxRateBp: number | null;
  language: Language;
};

/** The agreed revision's calculator inputs. Its minimum is the one that priced it, so the totals come out the same. */
function fromRevision(revision: typeof quoteRevisions.$inferSelect): Pick<Draft, "lines" | "ruleLines" | "adjustments" | "minimumCents" | "taxRateBp" | "language"> {
  return {
    lines: revision.lines.map(toLineInput),
    ruleLines: revision.ruleLines,
    adjustments: revision.adjustments,
    minimumCents: revision.minimumAppliedCents > 0 ? revision.subtotalCents + revision.minimumAppliedCents : null,
    taxRateBp: revision.taxRateBp,
    language: revision.customerLanguage,
  };
}

async function existingFor(tx: Tx, orgId: string, about: { jobId?: string | null; quoteId?: string | null }): Promise<Invoice | null> {
  const ors = [
    ...(about.jobId ? [eq(invoices.serviceJobId, about.jobId)] : []),
    ...(about.quoteId ? [eq(invoices.quoteId, about.quoteId)] : []),
  ];
  if (ors.length === 0) return null;
  const [row] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), ne(invoices.status, "void"), or(...ors)))
    .orderBy(asc(invoices.number))
    .limit(1);
  return row ?? null;
}

async function partiesFor(tx: Tx, orgId: string, customerId: string | null, propertyId: string | null) {
  if (customerId) {
    const [customer] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.orgId, orgId), eq(customers.id, customerId)));
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
  }
  if (propertyId) {
    const [property] = await tx.select().from(properties).where(and(eq(properties.orgId, orgId), eq(properties.id, propertyId)));
    if (!property) throw new Error("PROPERTY_NOT_FOUND");
    if (customerId && property.customerId !== customerId) throw new Error("PROPERTY_MISMATCH");
    customerId = property.customerId;
  }
  const language = customerId
    ? ((await tx.select({ language: customers.language }).from(customers).where(and(eq(customers.orgId, orgId), eq(customers.id, customerId))))[0]
        ?.language ?? "en")
    : "en";
  return { customerId, propertyId, language: isLanguage(language) ? language : "en" };
}

/**
 * A draft invoice. From work, it copies the agreed quote revision the work was booked on (or needs
 * `lines` when the work had no quote); from a quote, its current revision, which must be agreed
 * (approved, sent, or won). Without either, it needs `lines`. A job or quote that already has an
 * invoice (not void) gets that one back with `created: false`.
 */
export async function createInvoice(actor: InvoiceActor, input: CreateInvoiceInput, deps?: Deps): Promise<{ invoice: InvoiceDetail; created: boolean }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const outcome = await db().transaction(async (tx) => {
    let draft: Draft;
    const profile = await getProfileWith(orgId, tx);
    let job: typeof serviceJobs.$inferSelect | undefined;
    if (input.serviceJobId) {
      [job] = await tx.select().from(serviceJobs).where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, input.serviceJobId)));
      if (!job) throw new Error("SERVICE_JOB_NOT_FOUND");
      if (job.status === "cancelled") throw new Error("JOB_CANCELLED");
    }
    const quoteId = input.quoteId ?? job?.quoteId ?? null;
    // Serialize invoicing per business, so two asks for the same job can't both make one.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invoices:${orgId}`}))`);
    const existing = await existingFor(tx, orgId, { jobId: job?.id, quoteId });
    if (existing) return { id: existing.id, created: false };

    if (quoteId) {
      const [quote] = await tx.select().from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
      if (!quote) throw new Error("QUOTE_NOT_FOUND");
      if (!job) {
        [job] = await tx
          .select()
          .from(serviceJobs)
          .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.quoteId, quote.id), ne(serviceJobs.status, "cancelled")));
      }
      // Work booked from the quote is billed on the revision it was agreed on; otherwise the quote's current one.
      const revisionId = job?.quoteRevisionId ?? quote.currentRevisionId;
      if (!job?.quoteRevisionId && !AGREED_QUOTE.includes(quote.status)) throw new Error(`QUOTE_NOT_AGREED: it is ${quote.status}`);
      const [revision] = await tx
        .select()
        .from(quoteRevisions)
        .where(and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.id, revisionId ?? "")));
      if (!revision) throw new Error("QUOTE_NOT_FOUND");
      const copied = fromRevision(revision);
      const parties = await partiesFor(tx, orgId, job?.customerId ?? quote.customerId, job?.propertyId ?? quote.propertyId);
      draft = {
        title: input.title?.trim() || job?.title || quote.title,
        customerId: parties.customerId,
        propertyId: parties.propertyId,
        serviceJobId: job?.id ?? null,
        quoteId: quote.id,
        quoteRevisionId: revision.id,
        ...copied,
        // `lines` stated with a quote replace its lines; its extras stay (see `updateInvoice`).
        ...(input.lines?.length ? { lines: await resolveLines(orgId, input.lines, tx), adjustments: copied.adjustments.filter((a) => a.kind !== "override") } : {}),
      };
    } else {
      if (!input.lines?.length) throw new Error(job ? "NEEDS_LINES: the work has no quote to copy" : "NO_LINES");
      const parties = await partiesFor(tx, orgId, input.customerId ?? job?.customerId ?? null, input.propertyId ?? job?.propertyId ?? null);
      const title = input.title?.trim() || job?.title || "";
      if (!title) throw new Error("INVOICE_TITLE_REQUIRED");
      draft = {
        title,
        ...parties,
        serviceJobId: job?.id ?? null,
        quoteId: null,
        quoteRevisionId: null,
        lines: await resolveLines(orgId, input.lines, tx),
        ruleLines: [],
        adjustments: [],
        minimumCents: null,
        taxRateBp: profile.taxRateBp,
      };
    }

    const calc = totalsFor(draft);
    const number = await takeInvoiceNumber(tx, orgId);
    const id = newId("inv");
    await tx.insert(invoices).values({
      id,
      orgId,
      number,
      title: draft.title,
      customerId: draft.customerId,
      propertyId: draft.propertyId,
      serviceJobId: draft.serviceJobId,
      quoteId: draft.quoteId,
      quoteRevisionId: draft.quoteRevisionId,
      status: "draft",
      lines: calc.lines,
      ruleLines: calc.ruleLines,
      adjustments: draft.adjustments,
      minimumCents: draft.minimumCents,
      taxRateBp: draft.taxRateBp,
      subtotalCents: calc.subtotalCents,
      minimumAppliedCents: calc.minimumAppliedCents,
      adjustmentCents: calc.adjustmentCents,
      taxCents: calc.taxCents,
      totalCents: calc.totalCents,
      language: draft.language,
      notes: input.notes?.trim() || null,
      payToken: randomBytes(18).toString("base64url"),
      createdByMemberId: actor.memberId,
      createdAt: now,
      updatedAt: now,
    });
    const depositCents = draft.quoteId ? await applyDeposits(tx, orgId, draft.quoteId, id) : 0;
    await recordEvent(
      { orgId, kind: "invoice.created", refId: id, memberId: actor.memberId, data: { number, jobId: draft.serviceJobId, quoteId: draft.quoteId, depositCents } },
      tx,
    );
    return { id, created: true };
  });
  return { invoice: (await getInvoice(orgId, outcome.id, { now })) as InvoiceDetail, created: outcome.created };
}

/**
 * Moves the deposits paid on a quote's link onto its new invoice, which counts them as paid. The invoice
 * stays a draft: a deposit doesn't send it. Takes the quote's row lock first, as `recordStripeDeposit`
 * does, so a deposit landing meanwhile is either moved here or finds this invoice.
 */
async function applyDeposits(tx: Tx, orgId: string, quoteId: string, invoiceId: string): Promise<number> {
  await tx.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId))).for("update");
  const moved = await tx
    .update(payments)
    .set({ invoiceId })
    .where(and(eq(payments.orgId, orgId), eq(payments.quoteId, quoteId), isNull(payments.invoiceId), isNull(payments.removedAt)))
    .returning({ amountCents: payments.amountCents });
  const total = moved.reduce((sum, p) => sum + p.amountCents, 0);
  if (total > 0) await tx.update(invoices).set({ amountPaidCents: total }).where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
  return total;
}

export type UpdateInvoiceInput = {
  /** Replaces every line. The quote's extras (rule amounts, minimum, discount) stay; a total it set doesn't. */
  lines?: InvoiceLineInput[];
  title?: string;
  /** null clears them. */
  notes?: string | null;
  /** `YYYY-MM-DD`; null goes back to the business's payment terms. */
  dueDate?: string | null;
};

/** Changes a draft. Once it's sent, its lines are frozen (`INVOICE_NOT_DRAFT`). */
export async function updateInvoice(actor: InvoiceActor, invoiceId: string, input: UpdateInvoiceInput, deps?: Deps): Promise<InvoiceDetail> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  await db().transaction(async (tx) => {
    const invoice = await lockInvoice(tx, orgId, invoiceId);
    if (invoice.status !== "draft") throw new Error("INVOICE_NOT_DRAFT");
    const changes: Partial<typeof invoices.$inferInsert> = { updatedAt: now };
    if (input.lines) {
      const lines = await resolveLines(orgId, input.lines, tx);
      // A price adjustment fixed the quote's total; with new lines, the lines price the job.
      const adjustments = invoice.adjustments.filter((a) => a.kind !== "override");
      const calc = totalsFor({ lines, ruleLines: invoice.ruleLines, minimumCents: invoice.minimumCents, adjustments, taxRateBp: invoice.taxRateBp });
      // A deposit already on the draft is money in: its lines can't bill less than that.
      if (calc.totalCents < invoice.amountPaidCents) throw new Error(`BELOW_PAID: ${formatCents(invoice.amountPaidCents, "en")} is already paid on it`);
      Object.assign(changes, {
        lines: calc.lines,
        ruleLines: calc.ruleLines,
        adjustments,
        subtotalCents: calc.subtotalCents,
        minimumAppliedCents: calc.minimumAppliedCents,
        adjustmentCents: calc.adjustmentCents,
        taxCents: calc.taxCents,
        totalCents: calc.totalCents,
      });
    }
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new Error("INVOICE_TITLE_REQUIRED");
      changes.title = title;
    }
    if (input.notes !== undefined) changes.notes = input.notes?.trim() || null;
    if (input.dueDate !== undefined) changes.dueDate = input.dueDate === null ? null : checkDate(input.dueDate);
    await tx.update(invoices).set(changes).where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
    await recordEvent({ orgId, kind: "invoice.updated", refId: invoiceId, memberId: actor.memberId, data: { fields: Object.keys(input) } }, tx);
  });
  return (await getInvoice(orgId, invoiceId, { now })) as InvoiceDetail;
}

/** Issues a draft inside an open transaction: dates set, lines frozen. Refuses a $0 invoice. */
async function issue(tx: Tx, invoice: Invoice, actor: InvoiceActor | null, profile: Profile, now: Date): Promise<Partial<Invoice>> {
  if (invoice.totalCents <= 0) throw new Error("INVOICE_ZERO");
  const issueDate = todayYmd(profile.timeZone, now);
  const dueDate = invoice.dueDate && invoice.dueDate >= issueDate ? invoice.dueDate : addDays(issueDate, profile.paymentTermsDays);
  const status = paidStatus(invoice.totalCents, invoice.amountPaidCents);
  const changes = {
    status,
    // A draft its quote's deposit already covers is paid as it's sent.
    ...(status === "paid" ? { paidAt: now } : {}),
    issueDate,
    dueDate,
    sentAt: now,
    sentByMemberId: actor?.memberId ?? null,
    updatedAt: now,
  } satisfies Partial<Invoice>;
  await tx.update(invoices).set(changes).where(and(eq(invoices.orgId, invoice.orgId), eq(invoices.id, invoice.id)));
  await recordEvent({ orgId: invoice.orgId, kind: "invoice.sent", refId: invoice.id, memberId: actor?.memberId, data: { dueDate } }, tx);
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Photos of the work on the PDF

/** At most this many of the work's photos go on an invoice's PDF. */
export const INVOICE_PHOTO_LIMIT = 8;

/** The work an invoice bills: its own, or the work booked from its quote. */
async function workOf(orgId: string, invoice: Pick<Invoice, "serviceJobId" | "quoteId">): Promise<string | null> {
  if (invoice.serviceJobId) return invoice.serviceJobId;
  if (!invoice.quoteId) return null;
  const [job] = await db()
    .select({ id: serviceJobs.id })
    .from(serviceJobs)
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.quoteId, invoice.quoteId), ne(serviceJobs.status, "cancelled")));
  return job?.id ?? null;
}

export type InvoicePhoto = WorkPhotoView & { onPdf: boolean };

/** The photos on the invoice's work, oldest first, each marked if it's on the PDF. Empty when it bills no work. */
export async function invoicePhotos(orgId: string, invoice: Pick<Invoice, "serviceJobId" | "quoteId" | "pdfPhotoIds">): Promise<InvoicePhoto[]> {
  const jobId = await workOf(orgId, invoice);
  if (!jobId) return [];
  const chosen = new Set(invoice.pdfPhotoIds);
  return (await listWorkPhotos(orgId, { jobId })).map((photo) => ({ ...photo, onPdf: chosen.has(photo.id) }));
}

/**
 * Puts exactly these photos of the invoice's work on its PDF (none to take them all off), and renders
 * the PDF again if it has one. Any time before it's void: photos aren't money, so a sent invoice takes them too, and goes
 * out with them when it's sent again. Throws `NOT_PRIVILEGED`, `INVOICE_VOID`, `INVOICE_NO_WORK` (it bills
 * no work), `INVOICE_PHOTO_NOT_FOUND`, or `INVOICE_PHOTO_LIMIT`.
 */
export async function setInvoicePhotos(actor: InvoiceActor, invoiceId: string, photoIds: string[], deps?: Deps): Promise<InvoiceDetail> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const wanted = [...new Set(photoIds)];
  if (wanted.length > INVOICE_PHOTO_LIMIT) throw new Error("INVOICE_PHOTO_LIMIT");
  const rendered = await db().transaction(async (tx) => {
    const invoice = await lockInvoice(tx, orgId, invoiceId);
    if (invoice.status === "void") throw new Error("INVOICE_VOID");
    const photos = await invoicePhotos(orgId, invoice);
    if (photos.length === 0 && wanted.length > 0) throw new Error(invoice.serviceJobId || invoice.quoteId ? "INVOICE_PHOTO_NOT_FOUND" : "INVOICE_NO_WORK");
    const known = new Set(photos.map((p) => p.id));
    if (wanted.some((id) => !known.has(id))) throw new Error("INVOICE_PHOTO_NOT_FOUND");
    // Kept in the order they were taken, which is how they print.
    const pdfPhotoIds = photos.filter((p) => wanted.includes(p.id)).map((p) => p.id);
    await tx.update(invoices).set({ pdfPhotoIds, updatedAt: now }).where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
    await recordEvent({ orgId, kind: "invoice.photos", refId: invoiceId, memberId: actor.memberId, data: { photoIds: pdfPhotoIds } }, tx);
    return invoice.pdfUrl !== null;
  });
  // A draft gets its PDF when it's sent; one already made is made again with the photos.
  if (rendered) await safeRender(orgId, invoiceId);
  return (await getInvoice(orgId, invoiceId, { now })) as InvoiceDetail;
}

/** The chosen photos' bytes for the PDF, skipping any taken off the work since or that can't be read. */
async function pdfPhotosOf(orgId: string, invoice: Invoice): Promise<QuotePdfPhoto[]> {
  if (invoice.pdfPhotoIds.length === 0) return [];
  const chosen = (await invoicePhotos(orgId, invoice)).filter((p) => p.onPdf && p.mimeType && /^image\/(jpe?g|png)$/i.test(p.mimeType));
  const loaded = await Promise.all(
    chosen.slice(0, INVOICE_PHOTO_LIMIT).map(async (p) => {
      try {
        const bytes = await readStoredFile(p.url);
        return bytes ? { bytes, mimeType: p.mimeType! } : null;
      } catch (error) {
        console.warn("invoices: a photo could not be read for the PDF", error);
        return null;
      }
    }),
  );
  return loaded.filter((p): p is QuotePdfPhoto => p !== null);
}

/**
 * The invoice's quote's before-and-after for the PDF, as a JPEG to keep the PDF small, with the total
 * only when the business shows customers line prices. Null without one; one that fails to draw is logged
 * and left off, never failing the invoice.
 */
async function pdfBeforeAfterOf(orgId: string, invoice: Invoice, language: Language, linePrices: boolean): Promise<QuotePdfPhoto | null> {
  if (!invoice.quoteId) return null;
  try {
    const pair = await beforeAfterFor(orgId, invoice.quoteId);
    if (!pair) return null;
    const { png } = await renderBeforeAfter(pair, language, { linePrices });
    return { bytes: new Uint8Array(await sharp(png).jpeg({ quality: 85 }).toBuffer()), mimeType: "image/jpeg" };
  } catch (error) {
    console.error("invoices: the before-and-after could not be drawn for the PDF", error);
    return null;
  }
}

export type RenderedInvoicePdf = { bytes: Uint8Array; pdfUrl: string; filename: string };

/** Renders the invoice as it stands and stores it as its PDF, replacing the one before. */
export async function renderInvoice(orgId: string, invoiceId: string): Promise<RenderedInvoicePdf> {
  const invoice = await getInvoice(orgId, invoiceId);
  if (!invoice) throw new Error("INVOICE_NOT_FOUND");
  if (invoice.status === "void") throw new Error("INVOICE_VOID");
  const profile = await getProfileWith(orgId, db());
  const customer = invoice.customerId ? await getCustomer(orgId, invoice.customerId) : null;
  const property = customer?.properties.find((p) => p.id === invoice.propertyId) ?? null;
  const language = isLanguage(invoice.language) ? invoice.language : "en";
  const bytes = await renderInvoicePdf({
    profile,
    label: invoice.label,
    title: invoice.title,
    status: invoice.status,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lines: invoice.lines,
    ruleLines: invoice.ruleLines,
    adjustments: invoice.adjustments,
    subtotalCents: invoice.subtotalCents,
    minimumAppliedCents: invoice.minimumAppliedCents,
    adjustmentCents: invoice.adjustmentCents,
    taxRateBp: invoice.taxRateBp,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    notes: invoice.notes,
    customer: customer ? { name: customer.name, phones: customer.phones, emails: customer.emails } : null,
    property: property ? { address: property.address } : null,
    payUrl: invoice.payUrl,
    language,
    logo: await loadLogo(orgId),
    photos: await pdfPhotosOf(orgId, invoice),
    beforeAfter: await pdfBeforeAfterOf(orgId, invoice, language, profile.customerLinePrices),
  });
  const pdfUrl = await storeInvoicePdf(invoice.id, `${invoice.label}-${Date.now().toString(36)}`, bytes);
  await db().update(invoices).set({ pdfUrl }).where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
  if (invoice.pdfUrl && invoice.pdfUrl !== pdfUrl) {
    await deleteBlob(invoice.pdfUrl).catch((error) => console.error("invoices: old pdf delete failed", error));
  }
  return { bytes, pdfUrl, filename: invoicePdfFileName(invoice.label, invoice.title, language) };
}

/** A render that fails is logged, never failing the change that asked for it. */
async function safeRender(orgId: string, invoiceId: string): Promise<RenderedInvoicePdf | null> {
  try {
    return await renderInvoice(orgId, invoiceId);
  } catch (error) {
    console.error("invoices: pdf failed", error);
    return null;
  }
}

const defaultPost: Poster = (orgId, memberId, payload, kind) => postToMember(orgId, memberId, payload, kind);

/**
 * Sends the invoice: a draft is issued (dates set, lines frozen); one already sent is sent again as it
 * stands now. Either way the PDF is rendered and posted to the member, with the pay link when the
 * business takes cards, for them to forward. Nothing goes to the customer.
 */
export async function sendInvoice(actor: InvoiceActor, invoiceId: string, deps?: Deps): Promise<{ invoice: InvoiceDetail; issued: boolean; posted: boolean }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const issued = await db().transaction(async (tx) => {
    const invoice = await lockInvoice(tx, orgId, invoiceId);
    if (invoice.status === "void") throw new Error("INVOICE_VOID");
    if (invoice.status !== "draft") return false;
    await issue(tx, invoice, actor, await getProfileWith(orgId, tx), now);
    return true;
  });
  const rendered = await safeRender(orgId, invoiceId);
  const invoice = (await getInvoice(orgId, invoiceId, { now })) as InvoiceDetail;
  let posted = false;
  if (rendered) {
    const caption = invoiceCaption(invoice, actor.language);
    const service = actor.phoneE164 ? await memberPhoneService(orgId, actor.phoneE164) : null;
    const textOnly = service === "SMS" || service === "RCS";
    try {
      const result = await (deps?.post ?? defaultPost)(
        orgId,
        actor.memberId,
        textOnly
          ? { text: `${caption}\n${rendered.pdfUrl}` }
          : {
              text: caption,
              file: { filename: rendered.filename, mimeType: "application/pdf", data: Buffer.from(rendered.bytes) },
              fileUrl: rendered.pdfUrl,
            },
        "system",
      );
      posted = result.posted;
    } catch (error) {
      console.error("invoices: post failed", error);
    }
  }
  return { invoice, issued, posted };
}

// ---------------------------------------------------------------------------------------------
// Payments

export type RecordPaymentInput = {
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  /** `YYYY-MM-DD` in the business's time zone; today when left out. */
  receivedDate?: string;
  reference?: string;
};

/**
 * Records money a member received. A draft is issued first (they've been paid, so it's billed). Refuses
 * more than the balance (`OVERPAYMENT`), a paid invoice (`INVOICE_PAID`), and a void one (`INVOICE_VOID`).
 */
export async function recordPayment(
  actor: InvoiceActor,
  input: RecordPaymentInput,
  deps?: Deps,
): Promise<{ invoice: InvoiceDetail; payment: Payment; issued: boolean }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("INVALID_AMOUNT");
  if (!PAYMENT_METHODS.includes(input.method)) throw new Error("INVALID_METHOD");
  const outcome = await db().transaction(async (tx) => {
    const profile = await getProfileWith(orgId, tx);
    const today = todayYmd(profile.timeZone, now);
    const receivedDate = input.receivedDate ? checkDate(input.receivedDate) : today;
    if (receivedDate > today) throw new Error("INVALID_DATE: that day hasn't come yet");
    let invoice = await lockInvoice(tx, orgId, input.invoiceId);
    if (invoice.status === "void") throw new Error("INVOICE_VOID");
    const balance = balanceOf(invoice);
    if (invoice.status === "paid" || (invoice.status !== "draft" && balance === 0)) throw new Error("INVOICE_PAID");
    if (input.amountCents > balance) throw new Error(`OVERPAYMENT: the balance is ${formatCents(balance, "en")}`);
    let issued = false;
    if (invoice.status === "draft") {
      invoice = { ...invoice, ...(await issue(tx, invoice, actor, profile, now)) };
      issued = true;
    }
    const [payment] = await tx
      .insert(payments)
      .values({
        id: newId("pay"),
        orgId,
        invoiceId: invoice.id,
        amountCents: input.amountCents,
        method: input.method,
        receivedDate,
        reference: input.reference?.trim() || null,
        source: "manual",
        recordedByMemberId: actor.memberId,
        createdAt: now,
      })
      .returning();
    const paid = invoice.amountPaidCents + input.amountCents;
    const status = paidStatus(invoice.totalCents, paid);
    await tx
      .update(invoices)
      .set({ amountPaidCents: paid, status, paidAt: status === "paid" ? now : null, updatedAt: now })
      .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoice.id)));
    await recordEvent({ orgId, kind: "invoice.payment", refId: invoice.id, memberId: actor.memberId, data: { paymentId: payment.id, amountCents: input.amountCents, method: input.method } }, tx);
    return { payment, issued };
  });
  await safeRender(orgId, input.invoiceId);
  return { invoice: (await getInvoice(orgId, input.invoiceId, { now })) as InvoiceDetail, ...outcome };
}

export type StripePaymentOutcome =
  | { kind: "recorded"; invoice: InvoiceDetail; payment: Payment }
  /** More came in than was owed (a cash payment was recorded after the customer opened checkout). */
  | { kind: "overpaid"; invoice: InvoiceDetail; payment: Payment; overpaidCents: number }
  | { kind: "duplicate" }
  /** The invoice was voided before the money came in: nothing recorded, the owner refunds it in Stripe. */
  | { kind: "void_invoice"; invoice: InvoiceDetail };

/** The card a payment was made with, as Stripe reports it: `visa`, `4242`. */
export type CardDetails = { brand: string | null; last4: string | null };

/**
 * Records a card payment Stripe took for the invoice, once per Checkout Session. The amount is what
 * Stripe collected, whatever the balance: money that moved is never left off the books.
 *
 * Stripe's webhook and the customer's return to the done page both record through here, sometimes at the
 * same moment. Once holds anyway: each locks the invoice's row before looking for the session's payment,
 * so the second waits for the first to commit and then finds it (`duplicate`), and the unique index on
 * the session id refuses a second row whatever happens.
 */
export async function recordStripePayment(
  orgId: string,
  input: { invoiceId: string; amountCents: number; checkoutSessionId: string; paymentIntentId: string | null; card?: CardDetails | null },
  deps?: { now?: Date },
): Promise<StripePaymentOutcome> {
  const now = deps?.now ?? new Date();
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("INVALID_AMOUNT");
  const outcome = await db().transaction(async (tx) => {
    let invoice = await lockInvoice(tx, orgId, input.invoiceId);
    const [seen] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.stripeCheckoutSessionId, input.checkoutSessionId));
    if (seen) return { kind: "duplicate" as const };
    if (invoice.status === "void") return { kind: "void_invoice" as const };
    const profile = await getProfileWith(orgId, tx);
    if (invoice.status === "draft") invoice = { ...invoice, ...(await issue(tx, invoice, null, profile, now)) };
    const balance = balanceOf(invoice);
    const [payment] = await tx
      .insert(payments)
      .values({
        id: newId("pay"),
        orgId,
        invoiceId: invoice.id,
        amountCents: input.amountCents,
        method: "card",
        receivedDate: todayYmd(profile.timeZone, now),
        source: "stripe",
        stripeCheckoutSessionId: input.checkoutSessionId,
        stripePaymentIntentId: input.paymentIntentId,
        cardBrand: input.card?.brand ?? null,
        cardLast4: input.card?.last4 ?? null,
        reference: input.paymentIntentId,
        createdAt: now,
      })
      .returning();
    const paid = invoice.amountPaidCents + input.amountCents;
    const status = paidStatus(invoice.totalCents, paid);
    await tx
      .update(invoices)
      .set({ amountPaidCents: paid, status, paidAt: status === "paid" ? now : null, updatedAt: now })
      .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoice.id)));
    const overpaidCents = Math.max(0, input.amountCents - balance);
    await recordEvent(
      { orgId, kind: "invoice.payment", refId: invoice.id, data: { paymentId: payment.id, amountCents: input.amountCents, method: "card", source: "stripe", overpaidCents } },
      tx,
    );
    return overpaidCents > 0 ? { kind: "overpaid" as const, payment, overpaidCents } : { kind: "recorded" as const, payment };
  });
  if (outcome.kind === "duplicate") return outcome;
  const invoice = (await getInvoice(orgId, input.invoiceId, { now })) as InvoiceDetail;
  if (outcome.kind === "void_invoice") return { kind: "void_invoice", invoice };
  await safeRender(orgId, input.invoiceId);
  return { ...outcome, invoice };
}

/** Whether a Checkout Session's payment is already on the business's books. */
export async function stripePaymentRecorded(orgId: string, checkoutSessionId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orgId, orgId), eq(payments.stripeCheckoutSessionId, checkoutSessionId)));
  return Boolean(row);
}

export type StripeDepositOutcome =
  /**
   * `invoiceId` when the quote was already invoiced: the deposit went straight onto that invoice.
   * `overpaidCents` is how much more came in than was owed (deposits past the one asked, or past the
   * invoice's balance); `closedQuote` is set when the quote was lost or voided meanwhile. Either way the
   * owner refunds it in Stripe.
   */
  | { kind: "recorded"; payment: Payment; invoiceId: string | null; overpaidCents: number; closedQuote: "lost" | "void" | null }
  | { kind: "duplicate" };

/**
 * Records a deposit Stripe took on a quote's link, once per Checkout Session, for whatever Stripe
 * collected. It's held on the quote until the quote (or its work) is invoiced, when `createInvoice` moves
 * it onto that invoice; a quote invoiced already gets it on its invoice now (a draft stays a draft). The
 * quote's row is locked first, like `applyDeposits`, so the two can't miss each other.
 */
export async function recordStripeDeposit(
  orgId: string,
  input: { quoteId: string; amountCents: number; checkoutSessionId: string; paymentIntentId: string | null; card?: CardDetails | null },
  deps?: { now?: Date },
): Promise<StripeDepositOutcome> {
  const now = deps?.now ?? new Date();
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("INVALID_AMOUNT");
  const outcome = await db().transaction(async (tx) => {
    const [quote] = await tx
      .select({ id: quotes.id, status: quotes.status, depositCents: quotes.depositCents })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, input.quoteId)))
      .for("update");
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    const [seen] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.stripeCheckoutSessionId, input.checkoutSessionId));
    if (seen) return { kind: "duplicate" as const };
    const earlier = (await quoteDeposits(orgId, input.quoteId, tx)).reduce((sum, p) => sum + p.amountCents, 0);
    const profile = await getProfileWith(orgId, tx);
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), eq(invoices.quoteId, input.quoteId), ne(invoices.status, "void")))
      .orderBy(asc(invoices.number))
      .limit(1)
      .for("update");
    const [payment] = await tx
      .insert(payments)
      .values({
        id: newId("pay"),
        orgId,
        invoiceId: invoice?.id ?? null,
        quoteId: input.quoteId,
        amountCents: input.amountCents,
        method: "card",
        receivedDate: todayYmd(profile.timeZone, now),
        source: "stripe",
        stripeCheckoutSessionId: input.checkoutSessionId,
        stripePaymentIntentId: input.paymentIntentId,
        cardBrand: input.card?.brand ?? null,
        cardLast4: input.card?.last4 ?? null,
        reference: input.paymentIntentId,
        createdAt: now,
      })
      .returning();
    // Past the deposit asked (a second tab's checkout), or past what the invoice still owed.
    let overpaidCents = Math.max(0, earlier + input.amountCents - (quote.depositCents ?? 0));
    if (invoice) {
      overpaidCents = Math.max(overpaidCents, input.amountCents - Math.max(0, invoice.totalCents - invoice.amountPaidCents));
      const paid = invoice.amountPaidCents + input.amountCents;
      const status = invoice.status === "draft" ? "draft" : paidStatus(invoice.totalCents, paid);
      await tx
        .update(invoices)
        .set({ amountPaidCents: paid, status, paidAt: status === "paid" ? now : null, updatedAt: now })
        .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoice.id)));
    }
    await recordEvent(
      { orgId, kind: "quote.deposit", refId: input.quoteId, data: { paymentId: payment.id, amountCents: input.amountCents, invoiceId: invoice?.id ?? null, overpaidCents } },
      tx,
    );
    const closedQuote = quote.status === "lost" || quote.status === "void" ? quote.status : null;
    return { kind: "recorded" as const, payment, invoiceId: invoice?.id ?? null, overpaidCents, closedQuote };
  });
  if (outcome.kind === "recorded" && outcome.invoiceId) await safeRender(orgId, outcome.invoiceId);
  return outcome;
}

/** The deposits paid on a quote's link (none taken back off), oldest first, wherever they are now. */
export async function quoteDeposits(orgId: string, quoteId: string, executor: Db | Tx = db()): Promise<Payment[]> {
  return executor
    .select()
    .from(payments)
    .where(and(eq(payments.orgId, orgId), eq(payments.quoteId, quoteId), isNull(payments.removedAt)))
    .orderBy(asc(payments.receivedDate), asc(payments.createdAt), asc(payments.id));
}

/** Takes a mistaken manual payment back off its invoice. A card payment through Stripe is refunded in Stripe instead. */
export async function removePayment(actor: InvoiceActor, paymentId: string, deps?: Deps): Promise<InvoiceDetail> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const invoiceId = await db().transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(and(eq(payments.orgId, orgId), eq(payments.id, paymentId)));
    if (!payment || payment.removedAt) throw new Error("PAYMENT_NOT_FOUND");
    if (payment.source === "stripe" || !payment.invoiceId) throw new Error("STRIPE_PAYMENT");
    const invoice = await lockInvoice(tx, orgId, payment.invoiceId);
    await tx
      .update(payments)
      .set({ removedAt: now, removedByMemberId: actor.memberId })
      .where(and(eq(payments.orgId, orgId), eq(payments.id, paymentId)));
    const paid = invoice.amountPaidCents - payment.amountCents;
    const status = paidStatus(invoice.totalCents, paid);
    await tx
      .update(invoices)
      .set({ amountPaidCents: paid, status, paidAt: status === "paid" ? invoice.paidAt : null, updatedAt: now })
      .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoice.id)));
    await recordEvent({ orgId, kind: "invoice.payment_removed", refId: invoice.id, memberId: actor.memberId, data: { paymentId, amountCents: payment.amountCents } }, tx);
    return invoice.id;
  });
  await safeRender(orgId, invoiceId);
  return (await getInvoice(orgId, invoiceId, { now })) as InvoiceDetail;
}

export type StripeRefundOutcome =
  | { kind: "recorded"; paymentId: string; invoiceId: string | null; quoteId: string | null; refundedCents: number; full: boolean }
  | { kind: "unchanged" }
  | { kind: "not_found" };

/**
 * Records a refund the business made in Stripe on a card payment, from the charge's `amount_refunded`
 * (everything refunded so far, so a repeated or out-of-order event changes nothing twice). The payment
 * keeps what's left of it, and its invoice's paid amount and status follow; refunded in full, it comes
 * off like a removed payment. A deposit not yet on an invoice just shrinks. Stripe payments only.
 */
export async function recordStripeRefund(
  orgId: string,
  input: { paymentIntentId: string; amountRefundedCents: number },
  deps?: Deps,
): Promise<StripeRefundOutcome> {
  const now = deps?.now ?? new Date();
  const outcome = await db().transaction(async (tx): Promise<StripeRefundOutcome> => {
    const [found] = await tx
      .select({ id: payments.id, invoiceId: payments.invoiceId })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), eq(payments.source, "stripe"), eq(payments.stripePaymentIntentId, input.paymentIntentId)));
    if (!found) return { kind: "not_found" };
    // The invoice first, then the payment, the order every payment change locks in.
    const invoice = found.invoiceId ? await lockInvoice(tx, orgId, found.invoiceId) : null;
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, orgId), eq(payments.id, found.id)))
      .for("update");
    if (!payment) return { kind: "not_found" };
    const charged = payment.amountCents + payment.refundedCents;
    const refunded = Math.min(Math.max(0, Math.trunc(input.amountRefundedCents)), charged);
    const delta = refunded - payment.refundedCents;
    if (delta <= 0 || payment.removedAt) return { kind: "unchanged" };
    const full = refunded === charged;
    await tx
      .update(payments)
      .set(full ? { refundedCents: refunded, removedAt: now } : { refundedCents: refunded, amountCents: charged - refunded })
      .where(and(eq(payments.orgId, orgId), eq(payments.id, payment.id)));
    if (invoice && payment.invoiceId) {
      const paid = Math.max(0, invoice.amountPaidCents - delta);
      const status = invoice.status === "void" ? invoice.status : paidStatus(invoice.totalCents, paid);
      await tx
        .update(invoices)
        .set({ amountPaidCents: paid, status, paidAt: status === "paid" ? invoice.paidAt : null, updatedAt: now })
        .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoice.id)));
    }
    await recordEvent(
      {
        orgId,
        kind: payment.invoiceId ? "invoice.refund" : "quote.deposit_refund",
        refId: payment.invoiceId ?? payment.quoteId ?? payment.id,
        data: { paymentId: payment.id, refundedCents: delta, full },
      },
      tx,
    );
    return { kind: "recorded", paymentId: payment.id, invoiceId: payment.invoiceId, quoteId: payment.quoteId, refundedCents: delta, full };
  });
  if (outcome.kind === "recorded" && outcome.invoiceId) await safeRender(orgId, outcome.invoiceId);
  return outcome;
}

/** The owners' text when a refund made in Stripe is recorded: how much, and on what. */
export function stripeRefundText(input: { amountCents: number; what: string | null }, language: Language): string {
  return language === "es"
    ? `Reembolso de ${money(input.amountCents, language)} registrado en ${input.what ?? "un pago"} (hecho en Stripe).`
    : `Recorded a ${money(input.amountCents, language)} refund on ${input.what ?? "a payment"} (made in Stripe).`;
}

/**
 * Voids an invoice with no payments on it (`INVOICE_HAS_PAYMENTS` otherwise). Its PDF is deleted, and its
 * job can be invoiced again. Deposits from its quote's link don't count: they go back to the quote, for
 * the invoice that replaces it.
 */
export async function voidInvoice(actor: InvoiceActor, invoiceId: string, input: { reason?: string } = {}, deps?: Deps): Promise<InvoiceDetail> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const pdfUrl = await db().transaction(async (tx) => {
    const invoice = await lockInvoice(tx, orgId, invoiceId);
    if (invoice.status === "void") return null;
    const live = await tx
      .select({ quoteId: payments.quoteId, amountCents: payments.amountCents })
      .from(payments)
      .where(and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoiceId), isNull(payments.removedAt)));
    const deposits = live.filter((p) => p.quoteId !== null).reduce((sum, p) => sum + p.amountCents, 0);
    if (live.some((p) => p.quoteId === null) || invoice.amountPaidCents !== deposits) throw new Error("INVOICE_HAS_PAYMENTS");
    if (deposits > 0) {
      await tx
        .update(payments)
        .set({ invoiceId: null })
        .where(and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoiceId), isNull(payments.removedAt)));
    }
    await tx
      .update(invoices)
      .set({ status: "void", amountPaidCents: 0, voidedAt: now, voidReason: input.reason?.trim() || null, pdfUrl: null, updatedAt: now })
      .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
    await recordEvent({ orgId, kind: "invoice.voided", refId: invoiceId, memberId: actor.memberId }, tx);
    return invoice.pdfUrl;
  });
  if (pdfUrl) await deleteBlob(pdfUrl).catch((error) => console.error("invoices: blob delete failed", error));
  return (await getInvoice(orgId, invoiceId, { now })) as InvoiceDetail;
}

/** The invoice behind a pay link, in whichever business: the token is the customer's only key. */
export async function invoiceByPayToken(token: string): Promise<Invoice | null> {
  if (!/^[\w-]{16,64}$/.test(token)) return null;
  const [row] = await db().select().from(invoices).where(eq(invoices.payToken, token));
  return row ?? null;
}

/** The payments still on an invoice (none taken back off), in the order they came in: what its receipt lists. */
export async function receiptPayments(orgId: string, invoiceId: string): Promise<Payment[]> {
  return db()
    .select()
    .from(payments)
    .where(and(eq(payments.orgId, orgId), eq(payments.invoiceId, invoiceId), isNull(payments.removedAt)))
    .orderBy(asc(payments.receivedDate), asc(payments.createdAt), asc(payments.id));
}

/**
 * The customer's receipt for an invoice as a PDF, made fresh each time and never stored: every payment
 * still on it, the total, what's been paid, and what's left. Null for a draft (not the customer's yet)
 * and for an invoice with nothing paid on it.
 */
export async function renderReceipt(orgId: string, invoiceId: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const [invoice] = await db().select().from(invoices).where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
  if (!invoice || invoice.status === "draft") return null;
  const paid = await receiptPayments(orgId, invoiceId);
  if (paid.length === 0) return null;
  const profile = await getProfileWith(orgId, db());
  const customer = invoice.customerId ? await getCustomer(orgId, invoice.customerId) : null;
  const language = isLanguage(invoice.language) ? invoice.language : "en";
  const label = invoiceLabel(invoice.number);
  const bytes = await renderReceiptPdf({
    profile,
    label,
    title: invoice.title,
    customerName: customer?.name ?? null,
    payments: paid.map((p) => ({ receivedDate: p.receivedDate, method: p.method, card: cardText(p), amountCents: p.amountCents })),
    totalCents: invoice.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    language,
    logo: await loadLogo(orgId),
  });
  return { bytes, filename: receiptPdfFileName(label, language) };
}

/** Notes the Checkout Session a pay link opened. */
export async function noteCheckoutSession(orgId: string, invoiceId: string, sessionId: string): Promise<void> {
  await db()
    .update(invoices)
    .set({ stripeCheckoutSessionId: sessionId })
    .where(and(eq(invoices.orgId, orgId), eq(invoices.id, invoiceId)));
}

/** Open invoices this many days or more past due, for the hourly nudge, oldest due first. */
export async function overdueInvoices(orgId: string, deps?: { now?: Date }): Promise<InvoiceView[]> {
  const list = await listInvoices(orgId, { status: "overdue", limit: 100 }, deps);
  return list.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.number - b.number);
}

// ---------------------------------------------------------------------------------------------
// What the assistant says (numbers only from here, never the model)

type Copy = {
  invoiceFor: (label: string, title: string, customer: string | null) => string;
  draftNext: string;
  sent: (issued: string, due: string) => string;
  dueOnReceipt: string;
  paidSoFar: (paid: string, balance: string) => string;
  paidInFull: string;
  overdue: (days: number) => string;
  payLink: (url: string) => string;
  noPayLink: string;
  voided: string;
  overpaid: (amount: string) => string;
  caption: (label: string, title: string, balance: string, due: string, url: string | null) => string;
  nobodyOwes: string;
  owes: (count: number, total: string) => string;
  owesLine: (name: string, amount: string, items: string) => string;
  itemDue: (label: string, due: string) => string;
  itemOverdue: (label: string, days: number) => string;
  paidNotice: (who: string, amount: string, label: string, rest: string) => string;
  paidRest: (balance: string | null) => string;
  overpaidNotice: (who: string, amount: string, label: string, over: string) => string;
  voidPaidNotice: (amount: string, label: string) => string;
  nudge: (items: string) => string;
  nudgeItem: (label: string, who: string, balance: string, days: number) => string;
};

const days = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const COPY: Record<Language, Copy> = {
  en: {
    invoiceFor: (label, title, customer) => `Invoice ${label} for ${title}${customer && customer !== title ? ` (${customer})` : ""}`,
    draftNext: "Draft. Say send it and I'll issue it and post the PDF for you to forward.",
    sent: (issued, due) => `Sent ${issued}, ${due}.`,
    dueOnReceipt: "due on receipt",
    paidSoFar: (paid, balance) => `Paid ${paid}, ${balance} still due.`,
    paidInFull: "Paid in full.",
    overdue: (n) => `${days(n, "day", "days")} overdue.`,
    payLink: (url) => `Pay link: ${url}`,
    noPayLink: "No card pay link: Stripe isn't connected in Settings.",
    voided: "Void.",
    overpaid: (amount) => `${amount} more than the total came in by card; refund it in Stripe.`,
    caption: (label, title, balance, due, url) => `Invoice ${label} for ${title}: ${balance}, ${due}.${url ? `\nPay online: ${url}` : ""}`,
    nobodyOwes: "Nobody owes you anything right now: no sent invoices are unpaid.",
    owes: (count, total) => `${count === 1 ? "1 customer owes" : `${count} customers owe`} ${total}:`,
    owesLine: (name, amount, items) => `${name} ${amount} (${items})`,
    itemDue: (label, due) => `${label}, due ${due}`,
    itemOverdue: (label, n) => `${label}, ${days(n, "day", "days")} overdue`,
    paidNotice: (who, amount, label, rest) => `${who} paid ${amount} by card on ${label}. ${rest}`,
    paidRest: (balance) => (balance ? `${balance} still due.` : "Paid in full."),
    overpaidNotice: (who, amount, label, over) => `${who} paid ${amount} by card on ${label}, ${over} more than was owed. Refund the difference in Stripe.`,
    voidPaidNotice: (amount, label) => `A card payment of ${amount} came in for ${label}, which is void. Refund it in Stripe.`,
    nudge: (items) => `Unpaid and past due: ${items}. Want me to resend one, or record a payment?`,
    nudgeItem: (label, who, balance, n) => `${label} ${who} ${balance} (${days(n, "day", "days")} late)`,
  },
  es: {
    invoiceFor: (label, title, customer) => `Factura ${label} para ${title}${customer && customer !== title ? ` (${customer})` : ""}`,
    draftNext: "Borrador. Dime envíala y la emito y te mando el PDF para que lo reenvíes.",
    sent: (issued, due) => `Enviada el ${issued}, ${due}.`,
    dueOnReceipt: "vence al recibirla",
    paidSoFar: (paid, balance) => `Pagado ${paid}, faltan ${balance}.`,
    paidInFull: "Pagada por completo.",
    overdue: (n) => `Vencida hace ${days(n, "día", "días")}.`,
    payLink: (url) => `Enlace de pago: ${url}`,
    noPayLink: "Sin enlace de pago con tarjeta: Stripe no está conectado en Configuración.",
    voided: "Anulada.",
    overpaid: (amount) => `Entraron ${amount} de más con tarjeta; devuélvelos en Stripe.`,
    caption: (label, title, balance, due, url) => `Factura ${label} para ${title}: ${balance}, ${due}.${url ? `\nPagar en línea: ${url}` : ""}`,
    nobodyOwes: "Nadie te debe nada ahora: no hay facturas enviadas sin pagar.",
    owes: (count, total) => `${count === 1 ? "1 cliente debe" : `${count} clientes deben`} ${total}:`,
    owesLine: (name, amount, items) => `${name} ${amount} (${items})`,
    itemDue: (label, due) => `${label}, vence el ${due}`,
    itemOverdue: (label, n) => `${label}, vencida hace ${days(n, "día", "días")}`,
    paidNotice: (who, amount, label, rest) => `${who} pagó ${amount} con tarjeta en ${label}. ${rest}`,
    paidRest: (balance) => (balance ? `Faltan ${balance}.` : "Pagada por completo."),
    overpaidNotice: (who, amount, label, over) => `${who} pagó ${amount} con tarjeta en ${label}, ${over} más de lo que debía. Devuelve la diferencia en Stripe.`,
    voidPaidNotice: (amount, label) => `Entró un pago con tarjeta de ${amount} para ${label}, que está anulada. Devuélvelo en Stripe.`,
    nudge: (items) => `Sin pagar y vencidas: ${items}. ¿Reenvío alguna o registro un pago?`,
    nudgeItem: (label, who, balance, n) => `${label} ${who} ${balance} (${days(n, "día", "días")} de atraso)`,
  },
};

const money = (cents: number, language: Language) => formatCents(cents, language, { concise: true });
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const quantityText = (quantity: number) => String(Number(quantity.toFixed(2)));
const shortDate = (ymd: string, language: Language) =>
  new Intl.DateTimeFormat(language === "es" ? "es-US" : "en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${ymd}T12:00:00Z`));

function dueText(invoice: Pick<Invoice, "issueDate" | "dueDate">, language: Language): string {
  const copy = COPY[language];
  if (!invoice.dueDate || invoice.dueDate === invoice.issueDate) return copy.dueOnReceipt;
  return language === "es" ? `vence el ${shortDate(invoice.dueDate, language)}` : `due ${shortDate(invoice.dueDate, language)}`;
}

/** The line a sent invoice's PDF goes out with: what's due, when, and the pay link. */
export function invoiceCaption(invoice: InvoiceView, language: Language): string {
  return COPY[language].caption(invoice.label, oneLine(invoice.title), money(invoice.balanceCents, language), dueText(invoice, language), invoice.payUrl);
}

/** The reply about one invoice: number, total, lines, where it stands, and the pay link. */
export function invoiceSummaryText(invoice: InvoiceView, language: Language, options: { cards?: boolean } = {}): string {
  const copy = COPY[language];
  const lines = invoice.lines.map((line) => {
    const name = oneLine(line.name);
    if (line.totalCents === null) return `${quantityText(line.quantity)} ${name}`;
    if (line.quantity === 1) return `${name} ${money(line.totalCents, language)}`;
    return line.unitCents !== null && Math.round(line.unitCents * line.quantity) === line.totalCents
      ? `${quantityText(line.quantity)} × ${name} @ ${money(line.unitCents, language)} = ${money(line.totalCents, language)}`
      : `${quantityText(line.quantity)} ${name} ${money(line.totalCents, language)}`;
  });
  const extras = [
    ...invoice.ruleLines.map((r) => `${oneLine(r.label)} ${money(r.cents, language)}`),
    ...(invoice.minimumAppliedCents > 0 ? [`${language === "es" ? "mínimo" : "minimum"} +${money(invoice.minimumAppliedCents, language)}`] : []),
    ...(invoice.adjustmentCents !== 0 ? [`${language === "es" ? "ajuste" : "adjustment"} ${invoice.adjustmentCents < 0 ? "-" : "+"}${money(Math.abs(invoice.adjustmentCents), language)}`] : []),
    ...(invoice.taxCents > 0 ? [`${language === "es" ? "impuesto" : "tax"} ${money(invoice.taxCents, language)}`] : []),
  ];
  const status: string[] = [];
  if (invoice.status === "draft") status.push(copy.draftNext);
  else if (invoice.status === "void") status.push(copy.voided);
  else {
    if (invoice.issueDate) status.push(copy.sent(shortDate(invoice.issueDate, language), dueText(invoice, language)));
    if (invoice.status === "paid") status.push(copy.paidInFull);
    else if (invoice.amountPaidCents > 0) status.push(copy.paidSoFar(money(invoice.amountPaidCents, language), money(invoice.balanceCents, language)));
    if (invoice.overdue) status.push(copy.overdue(invoice.daysOverdue));
    if (invoice.overpaidCents > 0) status.push(copy.overpaid(money(invoice.overpaidCents, language)));
  }
  const tail: string[] = [];
  if (invoice.payUrl) tail.push(copy.payLink(invoice.payUrl));
  else if (options.cards === false && invoice.status !== "void" && invoice.status !== "paid") tail.push(copy.noPayLink);
  return [
    `${copy.invoiceFor(invoice.label, oneLine(invoice.title), invoice.customerName)}: ${money(invoice.totalCents, language)}`,
    ...lines,
    ...(extras.length ? [extras.join(" · ")] : []),
    status.join(" "),
    ...tail,
  ]
    .filter(Boolean)
    .join("\n");
}

/** "Who owes me?": each customer's balance, most first, with their invoices. */
export function owedText(balances: CustomerBalance[], language: Language): string {
  const copy = COPY[language];
  if (balances.length === 0) return copy.nobodyOwes;
  const total = balances.reduce((sum, b) => sum + b.balanceCents, 0);
  return [
    copy.owes(balances.length, money(total, language)),
    ...balances.map((b) =>
      copy.owesLine(
        oneLine(b.name),
        money(b.balanceCents, language),
        b.invoices
          .map((i) => (i.overdue ? copy.itemOverdue(i.label, i.daysOverdue) : copy.itemDue(i.label, i.dueDate ? shortDate(i.dueDate, language) : "—")))
          .join("; "),
      ),
    ),
  ].join("\n");
}

/** The text to owners and admins when a card payment comes in through the pay link. */
export function stripePaidText(outcome: Exclude<StripePaymentOutcome, { kind: "duplicate" }>, amountCents: number, language: Language): string {
  const copy = COPY[language];
  const { invoice } = outcome;
  const who = oneLine(invoice.customerName ?? invoice.title);
  if (outcome.kind === "void_invoice") return copy.voidPaidNotice(money(amountCents, language), invoice.label);
  if (outcome.kind === "overpaid") return copy.overpaidNotice(who, money(amountCents, language), invoice.label, money(outcome.overpaidCents, language));
  return copy.paidNotice(who, money(amountCents, language), invoice.label, copy.paidRest(invoice.balanceCents > 0 ? money(invoice.balanceCents, language) : null));
}

/** The gentle nudge about invoices past due. Never sent to customers. */
export function invoiceNudgeText(list: InvoiceView[], language: Language): string {
  const copy = COPY[language];
  return copy.nudge(list.map((i) => copy.nudgeItem(i.label, oneLine(i.customerName ?? i.title), money(i.balanceCents, language), i.daysOverdue)).join("; "));
}

const CARD_BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover" };

/** A card brand as Stripe names it (`visa`, `amex`), the way people write it: "Visa", "American Express". */
export function cardBrandName(brand: string): string {
  const known = CARD_BRANDS[brand.toLowerCase()];
  if (known) return known;
  const words = brand.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The card a payment was made with, as a receipt prints it: "Visa •••• 4242". Null when Stripe didn't say. */
export function cardText(payment: Pick<Payment, "cardBrand" | "cardLast4">): string | null {
  const brand = payment.cardBrand && payment.cardBrand !== "unknown" ? cardBrandName(payment.cardBrand) : null;
  const last4 = payment.cardLast4 ? `•••• ${payment.cardLast4}` : null;
  return [brand, last4].filter(Boolean).join(" ") || null;
}

/** A one-line description of a payment, for replies: "$150 cash on Oct 18". */
export function paymentText(payment: Pick<Payment, "amountCents" | "method" | "receivedDate">, language: Language): string {
  const methods: Record<Language, Record<PaymentMethod, string>> = {
    en: { cash: "cash", check: "check", card: "card", other: "other" },
    es: { cash: "efectivo", check: "cheque", card: "tarjeta", other: "otro" },
  };
  return `${money(payment.amountCents, language)} ${methods[language][payment.method]} ${language === "es" ? "el" : "on"} ${shortDate(payment.receivedDate, language)}`;
}

