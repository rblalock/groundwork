import { defineTool } from "eve/tools";
import { z } from "zod";
import { INVOICE_PHOTO_LIMIT, setInvoicePhotos } from "../../../../core/invoices";
import { invoiceForTool, invoiceIdFrom, invoiceRefSchema, requireMoneyCaller } from "../../../../core/invoice-tools";
import { refuseFromEmail, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Choose which photos of the work print on an invoice's PDF, after the invoice: \"put the after photos on the invoice\", \"leave the photos off\". Owners and admins only. photoIds replaces the choice, so pass every photo that should be on it (get_invoice lists the work's photos with ids and onPdf); [] takes them all off. Works on a sent invoice too; it goes out with them when it's sent again. Reply in one line with how many photos are on it.",
  inputSchema: z.object({
    invoiceId: invoiceRefSchema,
    photoIds: z.array(z.string().min(1)).max(INVOICE_PHOTO_LIMIT),
  }),
  async execute({ invoiceId, photoIds }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireMoneyCaller(ctx);
      const invoice = await setInvoicePhotos(caller, await invoiceIdFrom(caller, invoiceId), photoIds);
      return { invoice: await invoiceForTool(invoice, caller), photosOnPdf: invoice.pdfPhotoIds.length };
    } catch (error) {
      return toolError(error);
    }
  },
});
