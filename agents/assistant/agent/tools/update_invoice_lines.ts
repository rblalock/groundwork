import { defineTool } from "eve/tools";
import { z } from "zod";
import { updateInvoice } from "../../../../core/invoices";
import { invoiceForTool, invoiceIdFrom, invoiceLinesSchema, invoiceRefSchema, requireMoneyCaller } from "../../../../core/invoice-tools";
import { refuseFromEmail, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Change a draft invoice: its lines, title, notes, or due date. Owners and admins only. lines replaces every line, so pass the full list with the change (get_invoice has them); prices only as the member stated or saved in the pricebook. Extras copied from the quote (rule amounts, minimum, discount) stay; a total the quote fixed by hand doesn't. A sent invoice can't change (INVOICE_NOT_DRAFT). Reply with summaryText.",
  inputSchema: z.object({
    invoiceId: invoiceRefSchema,
    lines: invoiceLinesSchema.optional(),
    title: z.string().min(1).max(160).optional(),
    notes: z.string().max(2000).nullable().optional(),
    dueDate: z.string().nullable().optional().describe("YYYY-MM-DD, only a day the member named. null goes back to the business's payment terms."),
  }),
  async execute({ invoiceId, ...changes }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireMoneyCaller(ctx);
      const invoice = await updateInvoice(caller, await invoiceIdFrom(caller, invoiceId), changes);
      return { invoice: await invoiceForTool(invoice, caller) };
    } catch (error) {
      return toolError(error);
    }
  },
});
