import { defineTool } from "eve/tools";
import { z } from "zod";
import { PHOTON } from "../../../../core/channel-dispatch";
import { approveQuotePolicy } from "../../../../core/policies";
import { approveQuote, askedApproval } from "../../../../core/quotes";
import { latestInbound, plain, refuseFromEmail, requireCaller, toolError, withSummaryText } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Approve a quote when the owner or an admin clearly says so (\"ok\", \"send it\", \"sí\", 👍) in answer to that quote: its summary was your last message to them, or the context names it as waiting on them. quoteId is required: take it from the context, the quote tools' results, or list_quotes. An ok that answers anything else is not an approval. When a tapback's context names a revision, pass it as expectedRevisionNumber. Results: ok; nothing_to_approve; not_ready (say what is still missing); revision_changed (the quote changed since that message: say so and send summaryText); confirm (they weren't asked about this quote yet, so nothing was approved: send its summaryText, and their next ok approves it). Crew cannot approve; use request_owner_approval for them.",
  inputSchema: z.object({
    quoteId: z.string().min(1).describe("The quote the member is answering."),
    expectedRevisionNumber: z.number().int().positive().optional(),
  }),
  approval: approveQuotePolicy,
  async execute({ quoteId, expectedRevisionNumber }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      // Over text, a member approves only a quote that was put to them. On the web the ok approves the
      // quote named, which must be one this owner or admin's business has (approveQuote checks both).
      const overText = ctx.session.auth.current?.authenticator === PHOTON;
      const source = overText ? await latestInbound(caller.orgId, caller.memberId, ["user", "reaction"]) : null;
      const asked = overText ? await askedApproval(caller.orgId, caller.memberId, source) : undefined;
      const result = await approveQuote(quoteId, caller, { expectedRevisionNumber, messageId: source?.id, asked });
      if ("quote" in result) return plain({ ...result, quote: withSummaryText(result.quote, caller) });
      return plain({
        ...result,
        candidates: result.candidates.map((q) => ({
          quoteId: q.quoteId,
          title: q.title,
          totalCents: q.totalCents,
          customerName: q.customerName,
          createdBy: q.createdBy,
        })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
