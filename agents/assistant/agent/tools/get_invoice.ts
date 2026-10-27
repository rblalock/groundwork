import { defineTool } from "eve/tools";
import { z } from "zod";
import { getInvoice, invoicePhotos } from "../../../../core/invoices";
import { invoiceForTool, invoiceIdFrom, invoiceRefSchema, requireMoneyCaller } from "../../../../core/invoice-tools";
import { toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Get one invoice in full: lines, totals, what's been paid (payments, with ids for remove_payment), the balance, dates, the pay link, the PDF, and the photos of its work (with ids and onPdf, for set_invoice_photos). Owners and admins only. summaryText is the reply to send about it.",
  inputSchema: z.object({ invoiceId: invoiceRefSchema }),
  async execute({ invoiceId }, ctx) {
    try {
      const caller = await requireMoneyCaller(ctx);
      const invoice = await getInvoice(caller.orgId, await invoiceIdFrom(caller, invoiceId));
      if (!invoice) throw new Error("INVOICE_NOT_FOUND");
      const photos = await invoicePhotos(caller.orgId, invoice);
      return {
        invoice: await invoiceForTool(invoice, caller),
        workPhotos: photos.map((p) => ({ photoId: p.id, description: p.description, addedBy: p.addedByName, addedAt: p.createdAt.toISOString(), onPdf: p.onPdf })),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
