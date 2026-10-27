import { defineTool } from "eve/tools";
import { z } from "zod";
import { removePayment } from "../../../../core/invoices";
import { invoiceForTool, requireMoneyCaller } from "../../../../core/invoice-tools";
import { refuseFromEmail, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Take a payment recorded by mistake back off its invoice (\"that was 150, not 200\": remove the wrong one, then record_payment the right one). Owners and admins only. paymentId comes from get_invoice's payments. A card payment through the pay link is refunded in Stripe, not removed here (STRIPE_PAYMENT). Reply with summaryText's balance line.",
  inputSchema: z.object({ paymentId: z.string().min(1) }),
  async execute({ paymentId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireMoneyCaller(ctx);
      return { invoice: await invoiceForTool(await removePayment(caller, paymentId), caller) };
    } catch (error) {
      return toolError(error);
    }
  },
});
