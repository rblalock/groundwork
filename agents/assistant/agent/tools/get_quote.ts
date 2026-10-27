import { defineTool } from "eve/tools";
import { z } from "zod";
import { invoiceForQuote, quoteDeposits } from "../../../../core/invoices";
import { isPrivileged } from "../../../../core/members";
import { getProfile } from "../../../../core/profile";
import { customerLinkFor } from "../../../../core/quote-link";
import { getQuote } from "../../../../core/quotes";
import { serviceJobsAbout, visitForTool } from "../../../../core/scheduling";
import { requireCaller, toolError, withSummaryText } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Get one quote in full: its current lines (with itemIds, for revise_quote), rules applied, totals, status, revisions, photos (attachments, oldest first, with ids for revise_quote's removePhotoIds), and customer. summaryText is the current summary to send when a member needs it again. work is its scheduled work and visits, if any. invoice, for owners and admins, is its invoice (number, status, balance), if it has one. customerLink, once it's approved, is the link the member sends the customer: there the customer sees the quote, approves it with their name, and pays the deposit the business asks for, if any. customerApproval says who approved it there and when; depositCents is the deposit asked then, and depositPaidCents (owners and admins) what's been paid of it.",
  inputSchema: z.object({ quoteId: z.string() }),
  async execute({ quoteId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const detail = await getQuote(caller.orgId, quoteId);
      if (!detail) throw new Error("QUOTE_NOT_FOUND");
      const privileged = isPrivileged(caller.role);
      const [jobs, profile, invoice, deposits, customerLink] = await Promise.all([
        serviceJobsAbout(caller, { quoteId }),
        getProfile(caller.orgId),
        // Its invoice's number and status for anyone; what's owed only for owners and admins.
        invoiceForQuote(caller.orgId, quoteId).then((ref) => (ref && !privileged ? { invoiceId: ref.invoiceId, label: ref.label, status: ref.status } : ref)),
        privileged && detail.depositCents ? quoteDeposits(caller.orgId, quoteId) : null,
        // A quote approved before links existed gets its link the first time it's asked for.
        detail.customerLink ? detail.customerLink : customerLinkFor(caller.orgId, quoteId),
      ]);
      return {
        ...withSummaryText({ ...detail, customerLink }, caller),
        ...(invoice ? { invoice } : {}),
        ...(deposits ? { depositPaidCents: deposits.reduce((sum, p) => sum + p.amountCents, 0) } : {}),
        work: jobs.map((job) => ({
          jobId: job.id,
          status: job.status,
          visits: job.visits.map((v) => visitForTool(v, profile.timeZone, caller.language)),
        })),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
