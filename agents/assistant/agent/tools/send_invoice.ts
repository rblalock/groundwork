import { defineTool } from "eve/tools";
import { z } from "zod";
import { sendInvoice } from "../../../../core/invoices";
import { invoiceForTool, invoiceIdFrom, invoiceRefSchema, requireMoneyCaller } from "../../../../core/invoice-tools";
import { refuseFromEmail, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Send an invoice: a draft is issued (dated today, due by the business's payment terms) and its lines freeze; one already sent goes again as it stands now. The PDF is posted to the member, with the card pay link when Stripe is connected, for them to forward. Nothing goes to the customer. Owners and admins only. Reply in one line that the PDF is above to forward, with summaryText's total, due date, and pay link.",
  inputSchema: z.object({ invoiceId: invoiceRefSchema }),
  async execute({ invoiceId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireMoneyCaller(ctx);
      const sent = await sendInvoice(caller, await invoiceIdFrom(caller, invoiceId));
      return { issued: sent.issued, pdfPosted: sent.posted, invoice: await invoiceForTool(sent.invoice, caller, { mentionPayLink: true }) };
    } catch (error) {
      return toolError(error);
    }
  },
});
