import { defineTool } from "eve/tools";
import { z } from "zod";
import { createInvoice, sendInvoice } from "../../../../core/invoices";
import { invoiceForTool, invoiceLinesSchema, requireMoneyCaller } from "../../../../core/invoice-tools";
import { refuseFromEmail, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Make an invoice. Owners and admins only. From finished work (serviceJobId, from close_service_job, read_schedule, or list_invoices' readyToInvoice) or an agreed quote (quoteId, from list_quotes): the agreed quote's lines and total are copied, so pass no lines. Work with no quote, or an invoice from scratch, needs lines with the prices the member stated; never make up an amount, ask instead. A job or quote that already has an invoice returns it (created false). send true issues it right away and posts the PDF to the member to forward, with the card pay link when Stripe is connected: use it when they say invoice it, bill them, or send it; leave it out for \"draft an invoice\". Reply with summaryText.",
  inputSchema: z.object({
    serviceJobId: z.string().optional(),
    quoteId: z.string().optional(),
    customerId: z.string().optional().describe("For an invoice from scratch, from find_customer."),
    propertyId: z.string().optional(),
    title: z.string().max(160).optional().describe("Only for an invoice from scratch: the address or the member's words for the work."),
    lines: invoiceLinesSchema.optional().describe("Only when there is no quote to copy, or the member said what to bill instead."),
    notes: z.string().max(2000).optional().describe("Printed on the invoice."),
    send: z.boolean().optional(),
  }),
  async execute({ send, ...input }, ctx) {
    try {
      // A draft may come from an email; issuing it waits for the member.
      if (send) refuseFromEmail(ctx);
      const caller = await requireMoneyCaller(ctx);
      const made = await createInvoice(caller, input);
      if (send && made.invoice.status === "draft") {
        const sent = await sendInvoice(caller, made.invoice.id);
        return { created: made.created, sent: true, pdfPosted: sent.posted, invoice: await invoiceForTool(sent.invoice, caller, { mentionPayLink: true }) };
      }
      return { created: made.created, sent: false, invoice: await invoiceForTool(made.invoice, caller) };
    } catch (error) {
      return toolError(error);
    }
  },
});
