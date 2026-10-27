import { defineTool } from "eve/tools";
import { z } from "zod";
import { listInvoices, paymentText, recordPayment, PAYMENT_METHODS } from "../../../../core/invoices";
import { invoiceForTool, invoiceIdFrom, requireMoneyCaller } from "../../../../core/invoice-tools";
import { cents } from "../../../../core/tool-schemas";
import { refuseFromEmail, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Record money a customer paid (\"Jane paid $150 cash\", \"got a check for 400 from the Oak St job\"). Owners and admins only. Name the invoice with invoiceId, or pass customer (the name they used) to use that customer's one unpaid invoice; with several, it returns them as candidates: ask which. amountCents is exactly what they said ($150 → 15000). Partial payments are fine; more than the balance is refused (OVERPAYMENT). A draft is issued first. receivedDate only when they named a day. Card payments through the pay link record themselves; this is for cash, checks, and cards taken in person. Reply with paymentText and summaryText's balance line.",
  inputSchema: z.object({
    invoiceId: z.string().optional().describe("invoiceId or number, when known."),
    customer: z.string().optional().describe("The customer's name as the member said it, when they didn't name the invoice."),
    amountCents: cents.refine((n) => n > 0, "More than zero."),
    method: z.enum(PAYMENT_METHODS),
    receivedDate: z.string().optional().describe("YYYY-MM-DD."),
    reference: z.string().max(200).optional().describe("A check number or note, in their words."),
  }),
  async execute({ invoiceId, customer, ...payment }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireMoneyCaller(ctx);
      let id: string;
      if (invoiceId) id = await invoiceIdFrom(caller, invoiceId);
      else {
        if (!customer?.trim()) throw new Error("INVOICE_REQUIRED");
        const open = (await listInvoices(caller.orgId, { query: customer, limit: 10 })).filter((i) => ["draft", "sent", "partially_paid"].includes(i.status));
        const unpaid = open.filter((i) => i.status !== "draft");
        // Sent invoices first; a lone draft is next (recording on it issues it).
        const pick = unpaid.length ? unpaid : open;
        if (pick.length === 0) throw new Error("NO_OPEN_INVOICE");
        if (pick.length > 1) {
          return {
            error: "AMBIGUOUS: more than one unpaid invoice matches. Ask which one, naming them.",
            candidates: pick.map((i) => ({ invoiceId: i.id, number: i.label, title: i.title, customerName: i.customerName, balanceCents: i.balanceCents })),
          };
        }
        id = pick[0].id;
      }
      const recorded = await recordPayment(caller, { invoiceId: id, ...payment });
      return {
        issuedFirst: recorded.issued,
        paymentText: paymentText(recorded.payment, caller.language),
        invoice: await invoiceForTool(recorded.invoice, caller),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
