import { z } from "zod";
import { readStoredFile } from "../../core/blob";
import {
  createInvoice,
  getInvoice,
  invoiceForQuote,
  invoicePhotos,
  invoicesForJobs,
  invoiceTotals,
  listInvoices,
  listPayments,
  paymentCursor,
  paymentsReceivedCents,
  type PaymentCursor,
  readyToInvoice,
  recordPayment,
  removePayment,
  sendInvoice,
  setInvoicePhotos,
  updateInvoice,
  voidInvoice,
  INVOICE_PHOTO_LIMIT,
  PAYMENT_METHODS,
  type InvoiceDetail,
  type InvoiceFilter,
  type InvoicePhoto,
  type InvoiceRef,
  type InvoiceTotals,
  type InvoiceView,
  type PaymentRow,
  type ReadyToInvoice,
} from "../../core/invoices";
import { invoicePdfFileName } from "../../core/pdf";
import { isLanguage } from "../../core/language";
import { HttpError, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, privilegedActor } from "./access";
import type { StoredFile } from "./quotes";

// Who may see and do what with invoices and payments: owners and admins only, since they're the
// business's money. Crew get a 403 from the routes and a 404 from the pages. A super admin's look-only
// view sees what an owner sees and changes nothing. Every change goes through core/invoices.ts,
// the same rules the assistant's tools follow.

export const INVOICE_FILTERS = ["draft", "open", "overdue", "paid", "void"] as const satisfies readonly InvoiceFilter[];
export const isInvoiceFilter = (value: unknown): value is (typeof INVOICE_FILTERS)[number] =>
  typeof value === "string" && (INVOICE_FILTERS as readonly string[]).includes(value);
export const INVOICE_PAGE_SIZE = 50;
export const PAYMENT_PAGE_SIZE = 100;

/** An invoice number from a page link (`?before=` / `?after=`), or nothing for anything else. */
export function parseInvoiceCursor(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,7}$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

/** A payment cursor from a page link, `<day>~<recorded at>~<id>`, or nothing for anything malformed. */
export function parsePaymentCursor(value: string | undefined): PaymentCursor | undefined {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([\w-]{1,64})$/);
  if (!match || Number.isNaN(Date.parse(match[2]))) return undefined;
  return { date: match[1], at: match[2], id: match[3] };
}

export const formatPaymentCursor = (cursor: PaymentCursor) => `${cursor.date}~${cursor.at}~${cursor.id}`;

/**
 * One page out of a keyset list fetched a row long, in either direction: the rows to show, and whether
 * there's more past them that way. Newer pages come back newest first, so their extra row is the first.
 */
function trimPage<T>(rows: T[], size: number, newer: boolean): { rows: T[]; more: boolean } {
  if (rows.length <= size) return { rows, more: false };
  return { rows: newer ? rows.slice(rows.length - size) : rows.slice(0, size), more: true };
}

function requireMoney(caller: AppCaller): void {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
}

/** `hasOlder` / `hasNewer`: whether the status and search have invoices past this page either way. */
export type InvoicesPage = { invoices: InvoiceView[]; totals: InvoiceTotals; ready: ReadyToInvoice[]; hasOlder: boolean; hasNewer: boolean };

/**
 * A page of the business's invoices for the status and search, by invoice number: the newest first, or
 * those older than `before` / newer than `after` (keyset, so a page never repeats or skips an invoice).
 */
export async function invoicesFor(
  caller: AppCaller,
  filter: { status?: InvoiceFilter; query?: string; before?: number; after?: number },
  size: number = INVOICE_PAGE_SIZE,
): Promise<InvoicesPage> {
  requireMoney(caller);
  const newer = filter.after !== undefined && filter.before === undefined;
  const base = { status: filter.status, query: filter.query };
  const [fetched, totals, ready] = await Promise.all([
    listInvoices(caller.orgId, { ...base, before: newer ? undefined : filter.before, after: newer ? filter.after : undefined, limit: size + 1 }),
    invoiceTotals(caller.orgId),
    readyToInvoice(caller.orgId),
  ]);
  const { rows: invoices, more } = trimPage(fetched, size, newer);
  const first = invoices[0];
  const last = invoices.at(-1);
  // The other way: anything past this page's far end.
  const beyond = newer
    ? last && (await listInvoices(caller.orgId, { ...base, before: last.number, limit: 1 })).length > 0
    : filter.before !== undefined && first && (await listInvoices(caller.orgId, { ...base, after: first.number, limit: 1 })).length > 0;
  return { invoices, totals, ready, hasOlder: newer ? Boolean(beyond) : more, hasNewer: newer ? more : Boolean(beyond) };
}

/** A page of payments, newest first, with the total ever received and whether there's more either way. */
export type PaymentsPage = { payments: PaymentRow[]; receivedCents: number; older: PaymentCursor | null; newer: PaymentCursor | null };

export async function paymentsFor(
  caller: AppCaller,
  page: { before?: PaymentCursor; after?: PaymentCursor } = {},
  size: number = PAYMENT_PAGE_SIZE,
): Promise<PaymentsPage> {
  requireMoney(caller);
  const goingNewer = page.after !== undefined && page.before === undefined;
  const [fetched, receivedCents] = await Promise.all([
    listPayments(caller.orgId, { before: goingNewer ? undefined : page.before, after: goingNewer ? page.after : undefined, limit: size + 1 }),
    paymentsReceivedCents(caller.orgId),
  ]);
  const { rows, more } = trimPage(fetched, size, goingNewer);
  const first = rows[0];
  const last = rows.at(-1);
  const beyond = goingNewer
    ? last && (await listPayments(caller.orgId, { before: paymentCursor(last), limit: 1 })).length > 0
    : page.before !== undefined && first && (await listPayments(caller.orgId, { after: paymentCursor(first), limit: 1 })).length > 0;
  const hasOlder = goingNewer ? Boolean(beyond) : more;
  const hasNewer = goingNewer ? more : Boolean(beyond);
  return {
    payments: rows,
    receivedCents,
    older: hasOlder && last ? paymentCursor(last) : null,
    newer: hasNewer && first ? paymentCursor(first) : null,
  };
}

export async function invoiceFor(caller: AppCaller, invoiceId: string): Promise<InvoiceDetail> {
  requireMoney(caller);
  const invoice = await getInvoice(caller.orgId, invoiceId);
  if (!invoice) throw notFound();
  return invoice;
}

/** A library refusal in the member's words. English adds the specifics (the balance). */
function invoiceRefusal(caller: AppCaller, error: unknown): never {
  if (error instanceof HttpError) throw error;
  const message = error instanceof Error ? error.message : "";
  const [code, ...rest] = message.split(":");
  const detail = rest.join(":").trim();
  if (code === "NOT_PRIVILEGED") throw new HttpError(403, code, "Only the owner or an admin can do that.");
  if (["INVOICE_NOT_FOUND", "PAYMENT_NOT_FOUND", "SERVICE_JOB_NOT_FOUND", "QUOTE_NOT_FOUND", "CUSTOMER_NOT_FOUND", "PROPERTY_NOT_FOUND"].includes(code)) {
    throw notFound();
  }
  const words = pageCopyFor(caller.language).invoices.errors[code];
  if (!words) throw error;
  const status = code.startsWith("INVALID") || code === "NO_LINES" || code === "INVOICE_NOT_PRICED" ? 400 : 409;
  throw new HttpError(status, code, detail && caller.language === "en" && (code === "OVERPAYMENT" || code === "BELOW_PAID") ? `${words} (${detail}).` : words);
}

const id = z.string().min(1).max(100);

const lineSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    quantity: z.number().positive().max(1_000_000),
    unitLabel: z.string().trim().max(40).optional(),
    unitCents: z.number().int().min(0).max(100_000_000),
    taxable: z.boolean().optional(),
  })
  .strict();

/**
 * Work or an agreed quote to invoice, or a new invoice from scratch (a title and lines, for a customer or
 * none). Work with no quote to copy comes with `lines`, what the owner or admin entered on the page; the
 * library refuses it without them (NEEDS_LINES), as it does the assistant.
 */
export const createSchema = z
  .object({
    serviceJobId: id.optional(),
    quoteId: id.optional(),
    /** An invoice from scratch: a title, its lines, and the customer when there is one. */
    customerId: id.optional(),
    title: z.string().trim().min(1).max(160).optional(),
    lines: z.array(lineSchema).min(1).max(50).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .refine((v) => !(v.serviceJobId && v.quoteId), "Not both serviceJobId and quoteId.")
  .refine((v) => Boolean(v.serviceJobId || v.quoteId) || Boolean(v.title && v.lines), "A new invoice needs a title and lines.")
  .refine((v) => !(v.customerId || v.title) || !(v.serviceJobId || v.quoteId), "customerId and title are for a new invoice.")
  .refine((v) => !v.lines || !v.quoteId, "Lines don't go with a quote.");

export async function createFromApp(caller: AppCaller, input: z.infer<typeof createSchema>): Promise<{ invoice: InvoiceDetail; created: boolean }> {
  const actor = privilegedActor(caller);
  try {
    return await createInvoice(actor, input);
  } catch (error) {
    invoiceRefusal(caller, error);
  }
}

export const updateSchema = z
  .object({
    lines: z.array(lineSchema).min(1).max(50).optional(),
    notes: z.string().max(2000).nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();

export async function updateFromApp(caller: AppCaller, invoiceId: string, input: z.infer<typeof updateSchema>): Promise<InvoiceDetail> {
  const actor = privilegedActor(caller);
  try {
    return await updateInvoice(actor, invoiceId, input);
  } catch (error) {
    invoiceRefusal(caller, error);
  }
}

/** The photos of the invoice's work, each marked if it's on the PDF. */
export async function invoicePhotosFor(caller: AppCaller, invoice: InvoiceDetail): Promise<InvoicePhoto[]> {
  requireMoney(caller);
  return invoicePhotos(caller.orgId, invoice);
}

export const photosSchema = z.object({ photoIds: z.array(id).max(INVOICE_PHOTO_LIMIT) }).strict();

/** Puts exactly these photos of the work on the invoice's PDF. */
export async function setPhotosFromApp(caller: AppCaller, invoiceId: string, input: z.infer<typeof photosSchema>): Promise<InvoiceDetail> {
  const actor = privilegedActor(caller);
  try {
    return await setInvoicePhotos(actor, invoiceId, input.photoIds);
  } catch (error) {
    invoiceRefusal(caller, error);
  }
}

/** Sends (or sends again) through the same `sendInvoice` as the assistant: the PDF goes to the member's texts. */
export async function sendFromApp(caller: AppCaller, invoiceId: string): Promise<{ invoice: InvoiceDetail; posted: boolean }> {
  const actor = privilegedActor(caller);
  try {
    const sent = await sendInvoice(actor, invoiceId);
    return { invoice: sent.invoice, posted: sent.posted };
  } catch (error) {
    invoiceRefusal(caller, error);
  }
}

export const paymentSchema = z
  .object({
    amountCents: z.number().int().positive().max(100_000_000),
    method: z.enum(PAYMENT_METHODS),
    receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    reference: z.string().trim().max(200).optional(),
  })
  .strict();

export async function recordPaymentFromApp(caller: AppCaller, invoiceId: string, input: z.infer<typeof paymentSchema>): Promise<InvoiceDetail> {
  const actor = privilegedActor(caller);
  try {
    return (await recordPayment(actor, { invoiceId, ...input })).invoice;
  } catch (error) {
    invoiceRefusal(caller, error);
  }
}

/** Takes a manual payment off its invoice; the payment must be on the invoice in the URL. */
export async function removePaymentFromApp(caller: AppCaller, invoiceId: string, paymentId: string): Promise<InvoiceDetail> {
  const actor = privilegedActor(caller);
  const invoice = await invoiceFor(caller, invoiceId);
  if (!invoice.payments.some((p) => p.id === paymentId && !p.removedAt)) throw notFound();
  try {
    return await removePayment(actor, paymentId);
  } catch (error) {
    invoiceRefusal(caller, error);
  }
}

export async function voidFromApp(caller: AppCaller, invoiceId: string): Promise<InvoiceDetail> {
  const actor = privilegedActor(caller);
  try {
    return await voidInvoice(actor, invoiceId);
  } catch (error) {
    invoiceRefusal(caller, error);
  }
}

/** The invoice's current PDF, served through the app so the same rule covers the file as the page. */
export async function invoicePdf(caller: AppCaller, invoiceId: string): Promise<StoredFile> {
  const invoice = await invoiceFor(caller, invoiceId);
  if (!invoice.pdfUrl) throw notFound();
  const bytes = await readStoredFile(invoice.pdfUrl);
  if (!bytes) throw notFound();
  return { bytes, contentType: "application/pdf", filename: invoicePdfFileName(invoice.label, invoice.title, isLanguage(invoice.language) ? invoice.language : "en") };
}

/** A customer's invoices and what they owe, for their page. Null for crew: invoices are the business's money. */
export async function customerInvoicesFor(
  caller: AppCaller,
  customerId: string,
): Promise<{ invoices: InvoiceView[]; balanceCents: number; overdueCents: number } | null> {
  if (caller.role === "member") return null;
  const invoices = await listInvoices(caller.orgId, { customerId, limit: 50 });
  const open = invoices.filter((i) => i.status === "sent" || i.status === "partially_paid");
  return {
    invoices,
    balanceCents: open.reduce((sum, i) => sum + i.balanceCents, 0),
    overdueCents: open.filter((i) => i.overdue).reduce((sum, i) => sum + i.balanceCents, 0),
  };
}

/**
 * A quote's invoice, for its page: everyone sees its number and status; owners and admins also open it,
 * see what's owed, and make one when there's none.
 */
export async function quoteInvoiceFor(
  caller: AppCaller,
  quoteId: string,
  quoteStatus: string,
): Promise<{ invoice: Pick<InvoiceRef, "invoiceId" | "label" | "status"> | null; canCreate: boolean; canOpen: boolean }> {
  const invoice = await invoiceForQuote(caller.orgId, quoteId);
  const privileged = caller.role !== "member";
  return {
    invoice: invoice && !privileged ? { invoiceId: invoice.invoiceId, label: invoice.label, status: invoice.status } : invoice,
    canCreate: privileged && !invoice && ["approved", "sent", "won"].includes(quoteStatus),
    canOpen: privileged,
  };
}

/** Each job's invoice, for the schedule's visit details: owners and admins only. */
export async function jobInvoicesFor(caller: AppCaller, jobIds: string[]): Promise<Record<string, InvoiceRef>> {
  if (caller.role === "member") return {};
  return Object.fromEntries(await invoicesForJobs(caller.orgId, [...new Set(jobIds)]));
}
