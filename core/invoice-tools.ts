// What the invoice tools share: the owner-or-admin check, finding the invoice a member names, and an
// invoice as a tool returns it, with the reply text the code wrote (so the model never does the math).
import { z } from "zod";
import { invoiceSummaryText, resolveInvoiceId, type InvoiceDetail, type InvoiceView } from "./invoices";
import { isPrivileged, type Caller } from "./members";
import { takesCardPayments } from "./stripe-connection";
import { lineSchema } from "./tool-schemas";
import { plain, requireCaller } from "./tool-context";

/** The caller, if they may see business-wide money; otherwise `NOT_PRIVILEGED`. */
export async function requireMoneyCaller(ctx: Parameters<typeof requireCaller>[0]): Promise<Caller> {
  const caller = await requireCaller(ctx);
  if (!isPrivileged(caller.role)) throw new Error("NOT_PRIVILEGED");
  return caller;
}

export const invoiceRefSchema = z.string().min(1).describe('The invoiceId from list_invoices or get_invoice, or its number as the member says it ("INV-0003", "3").');

export const invoiceLinesSchema = z
  .array(lineSchema.extend({ taxable: z.boolean().optional().describe("Leave out unless the member said it isn't taxed.") }))
  .min(1)
  .max(50);

export async function invoiceIdFrom(caller: Caller, ref: string): Promise<string> {
  const id = await resolveInvoiceId(caller.orgId, ref);
  if (!id) throw new Error("INVOICE_NOT_FOUND");
  return id;
}

/** An invoice for a tool result: the facts, then `summaryText`, the reply to send about it. */
export async function invoiceForTool(invoice: InvoiceView | InvoiceDetail, caller: Caller, options: { mentionPayLink?: boolean } = {}) {
  const cards = await takesCardPayments(caller.orgId);
  return plain({
    invoiceId: invoice.id,
    number: invoice.label,
    title: invoice.title,
    status: invoice.status,
    customerName: invoice.customerName,
    serviceJobId: invoice.serviceJobId,
    quoteId: invoice.quoteId,
    totalCents: invoice.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    balanceCents: invoice.balanceCents,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    overdue: invoice.overdue,
    daysOverdue: invoice.daysOverdue,
    payUrl: invoice.payUrl,
    pdfUrl: invoice.pdfUrl,
    lines: invoice.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitLabel: l.unitLabel, unitCents: l.unitCents, totalCents: l.totalCents })),
    ...("payments" in invoice
      ? {
          payments: invoice.payments
            .filter((p) => !p.removedAt)
            .map((p) => ({ paymentId: p.id, amountCents: p.amountCents, method: p.method, receivedDate: p.receivedDate, source: p.source, reference: p.reference })),
        }
      : {}),
    summaryText: invoiceSummaryText(invoice, caller.language, { cards: options.mentionPayLink ? cards : undefined }),
  });
}
