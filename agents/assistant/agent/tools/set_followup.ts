import { defineTool } from "eve/tools";
import { z } from "zod";
import { setFollowup } from "../../../../core/quotes";
import { refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Set when to check in about an approved or sent quote (\"remind me in a week\"), replacing the current reminder. The reminder never lands in quiet hours. To change the default for every quote, use update_profile followUpDays instead.",
  inputSchema: z.object({
    quoteId: z.string(),
    days: z.number().int().min(1).max(60),
  }),
  async execute({ quoteId, days }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const { dueAt } = await setFollowup(quoteId, days, caller);
      return { dueAt: dueAt.toISOString() };
    } catch (error) {
      return toolError(error);
    }
  },
});
