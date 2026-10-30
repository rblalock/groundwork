import { defineTool } from "eve/tools";
import { z } from "zod";
import { proposeRepeat } from "../../../../core/repeat-quote";
import { requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Propose a past quote again at today's prices: \"same as last time\", \"quote Oak St again\", \"like last spring for Maria\". Pass quoteId, or customerId (from find_customer) for their last approved, sent, or won quote, else their latest (basis says which). Creates nothing. lines say which prices changed since (same, repriced), which items left the price book (retired: they go on unpriced for the owner), and which were never in it (unpriced); a retired rule is left off, and last time's set total or discount is reported, never repeated. preview is today's total from the calculator. Send summaryText as your reply: it is the numbered confirm. On yes, call create_quote with createQuoteInput as it is, changing only a quantity the member corrected.",
  inputSchema: z.object({
    quoteId: z.string().optional().describe("The quote to repeat."),
    customerId: z.string().optional().describe("The customer whose last quote to repeat, from find_customer. Ignored with quoteId."),
  }),
  async execute({ quoteId, customerId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      return await proposeRepeat(caller, { quoteId, customerId });
    } catch (error) {
      return toolError(error);
    }
  },
});
