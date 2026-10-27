import { defineTool } from "eve/tools";
import { z } from "zod";
import { voidInvoice } from "../../../../core/invoices";
import { invoiceForTool, invoiceIdFrom, invoiceRefSchema, requireMoneyCaller } from "../../../../core/invoice-tools";
import { refuseFromEmail, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Void an invoice that shouldn't be paid (made by mistake, the work was called off). Owners and admins only. Only with no payments on it (INVOICE_HAS_PAYMENTS): a mistaken manual payment comes off first with remove_payment. Its PDF is deleted, and its work can be invoiced again. Reply in one line.",
  inputSchema: z.object({ invoiceId: invoiceRefSchema, reason: z.string().max(500).optional() }),
  async execute({ invoiceId, reason }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireMoneyCaller(ctx);
      const invoice = await voidInvoice(caller, await invoiceIdFrom(caller, invoiceId), { reason });
      return { invoice: await invoiceForTool(invoice, caller) };
    } catch (error) {
      return toolError(error);
    }
  },
});
