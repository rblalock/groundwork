import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { getProfile } from "../../../../core/profile";
import { proposalForTool } from "../../../../core/proposals";
import { proposeRouteDays } from "../../../../core/route-days";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  approval: privilegedOnly("plan route days"),
  description:
    "Plan route days (\"plan our mowing days\", \"which day should each neighborhood get?\"): the code groups the business's recurring work by area from the yard, one loop for each weekday it works, and proposes moving each job whose day changes to its new weekday, starting next week with its own crew. Nothing moves yet: it's a proposal, decided like any other (apply_proposal, drop_proposal), and applying it puts the work on its new weekday too. Asking again replaces the one still open. Owners and admins only. Send text as it is; with no proposal, text says why. Never group stops or pick days yourself.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const { proposal, text } = await proposeRouteDays(caller);
      const { timeZone } = await getProfile(caller.orgId);
      return plain({
        ...(proposal ? { proposal: proposalForTool({ ...proposal, memberName: null }, timeZone, caller.language) } : {}),
        text,
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
