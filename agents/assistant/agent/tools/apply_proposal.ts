import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { applyProposal } from "../../../../core/proposals";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  approval: privilegedOnly("apply a proposal to move stops"),
  description:
    "Apply a proposal to move stops off a crew member's day that runs past its end, or off a day rain or heat is likely (the owners get it as a numbered text: \"Move 2 stops for Carlos? 1. … 2. … Reply the numbers to keep, 'all', or 'no'.\", or \"Move 3 stops to a dry day?\"). \"yes\", \"ok\", or \"all\" applies it all (no itemIds); numbers (\"1 and 2\", \"just 2\") apply only those stops: itemIds [\"1\", \"2\"]. proposalId is from read_schedule's proposals; leave it out when only one is open. The code re-checks every stop (unchanged since, the time still free, the crew carry what it needs), moves the ones that hold, and texts the crew as any move does; skipped says which didn't and why. Nothing reaches a customer: customerTexts are drafts for the owner to forward. Owners and admins only. Reply with summaryText as it is.",
  inputSchema: z.object({
    proposalId: z.string().optional(),
    itemIds: z.array(z.string().min(1).max(10)).min(1).max(20).optional().describe("The stop numbers the owner kept, as in the text; leave out for all."),
  }),
  async execute({ proposalId, itemIds }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const applied = await applyProposal(caller, { proposalId, itemIds });
      return plain({
        proposalId: applied.proposal.id,
        moved: applied.moved,
        skipped: applied.skipped,
        customerTexts: applied.customerTexts,
        crewTexted: applied.notified,
        summaryText: applied.summaryText,
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
