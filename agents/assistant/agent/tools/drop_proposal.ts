import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { dropProposal } from "../../../../core/proposals";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  approval: privilegedOnly("drop a proposal to move stops"),
  description:
    "Drop a proposal to move stops: \"no\", \"leave it\", or \"keep the day as is\" after a proposal text. Nothing moves and nobody is texted. proposalId is from read_schedule's proposals; leave it out when only one is open. Owners and admins only. Reply with summaryText as it is.",
  inputSchema: z.object({ proposalId: z.string().optional() }),
  async execute({ proposalId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const dropped = await dropProposal(caller, { proposalId });
      return plain({ proposalId: dropped.proposal.id, status: dropped.proposal.status, summaryText: dropped.summaryText });
    } catch (error) {
      return toolError(error);
    }
  },
});
