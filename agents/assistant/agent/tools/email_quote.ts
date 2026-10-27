import { defineTool } from "eve/tools";
import { z } from "zod";
import { emailQuote } from "../../../../core/quote-email";
import { plain, refuseFromEmail, requireCaller, toolError, withSummaryText } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Email a quote's PDF to the customer, when the member asks to email it (\"email it to Jane\", \"send it to jane@example.com\", \"mándaselo por correo\"). A bare \"send it\" is an approval, not this. It goes to `to` when the member typed an address, which is then saved on the customer, or else to the address saved on the customer. Never guess or make up an address. A draft is approved first, so only the owner or an admin can email one; crew can email an approved quote. The quote is then marked sent. `note` is a line the member asked to include, in their words. Results: sentTo; alreadySent (it just went to that address, nothing new was sent); replyTo null means the business has no email, so the customer's replies go nowhere.",
  inputSchema: z.object({
    quoteId: z.string().min(1),
    to: z.string().optional().describe("Only an address the member typed in this conversation."),
    note: z.string().max(500).optional(),
  }),
  async execute({ quoteId, to, note }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const result = await emailQuote({ quoteId, to, note }, caller);
      return plain({ ...result, quote: withSummaryText(result.quote, caller) });
    } catch (error) {
      return toolError(error);
    }
  },
});
