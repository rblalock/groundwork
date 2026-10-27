import { defineTool } from "eve/tools";
import { reviseQuote } from "../../../../core/quotes";
import { reviseQuoteSchema } from "../../../../core/tool-schemas";
import { linkJobToQuote } from "../../../../core/jobs";
import { refuseFromEmail, requireCaller, toolError, withSummaryText } from "../../../../core/tool-context";

const PHOTO_WINDOW_MS = 30 * 60 * 1000;

export default defineTool({
  description:
    "Change a quote: a new total (\"make it 375\" is an override adjustment, not a price change), added or removed lines, new quantities, a fact that changes which rules apply, the customer, or notes. With only the quoteId it attaches the photos the member just sent, which print on the PDF. removePhotoIds takes photos off the quote and its PDF (\"leave the second photo off\": get_quote lists them oldest first, with ids). Each call makes a new immutable revision, re-prices it in code, and posts the new PDF. An approved quote goes back to draft and needs approving again. Send summaryText back as your reply.",
  inputSchema: reviseQuoteSchema,
  async execute(input, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      // Photos the member sent in the last half hour attach to the quote and print on its PDF.
      const summary = await reviseQuote(input, caller, { photosSince: new Date(Date.now() - PHOTO_WINDOW_MS) });
      // Inside a job, the job is now about this quote, and shows on its page.
      await linkJobToQuote(caller, ctx.session.auth.current, summary.quoteId);
      return withSummaryText(summary, caller);
    } catch (error) {
      return toolError(error);
    }
  },
});
