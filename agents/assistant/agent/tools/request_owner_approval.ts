import { defineTool } from "eve/tools";
import { z } from "zod";
import { isPrivileged } from "../../../../core/members";
import { requestOwnerApproval } from "../../../../core/quotes";
import { refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "For crew: send a drafted quote to the owner for approval. The owners get a message about it in their own thread, and the crew member is told when the owner decides. Use it when crew say ok or send it about their quote. Returns notified (owners texted now) and queued (owners who get it when quiet hours end). When both are empty, no owner could be reached.",
  inputSchema: z.object({ quoteId: z.string() }),
  async execute({ quoteId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      if (isPrivileged(caller.role)) {
        return { error: "PRIVILEGED_CALLER: The owner or an admin approves directly with approve_quote." };
      }
      return await requestOwnerApproval(quoteId, caller);
    } catch (error) {
      return toolError(error);
    }
  },
});
