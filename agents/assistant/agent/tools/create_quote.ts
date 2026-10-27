import { defineTool } from "eve/tools";
import { z } from "zod";
import { createQuote } from "../../../../core/quotes";
import { createQuoteSchema } from "../../../../core/tool-schemas";
import { linkJobToQuote } from "../../../../core/jobs";
import { requireCaller, toolError, withSummaryText } from "../../../../core/tool-context";

const PHOTO_WINDOW_MS = 30 * 60 * 1000;

export default defineTool({
  description:
    "Create a quote. The code prices every line from the pricebook, applies the rules you name and the minimum, computes the total, renders the PDF, and posts it to the member. Use pricebook itemIds for saved items. A line without a price stays unpriced and the quote waits for the owner; never guess a price. A total the member names instead of unit prices is an override adjustment on this quote. Send summaryText back as your reply.",
  inputSchema: createQuoteSchema,
  async execute(input, ctx) {
    try {
      const caller = await requireCaller(ctx);
      // Photos the member sent in the last half hour attach to the quote and print on its PDF.
      const summary = await createQuote(input, caller, { photosSince: new Date(Date.now() - PHOTO_WINDOW_MS) });
      // Inside a job, the job is now about this quote, and shows on its page.
      await linkJobToQuote(caller, ctx.session.auth.current, summary.quoteId);
      return withSummaryText(summary, caller);
    } catch (error) {
      return toolError(error);
    }
  },
});
