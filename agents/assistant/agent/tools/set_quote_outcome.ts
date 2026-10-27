import { defineTool } from "eve/tools";
import { z } from "zod";
import { isPrivileged } from "../../../../core/members";
import { setQuoteOutcome } from "../../../../core/quotes";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Record what happened to an approved quote: sent (\"sent it\"), won (\"she said yes\"), lost (\"lost it\"), or void (cancel it). Won, lost, and void stop the follow-up reminders. When the owner or an admin marks a draft sent, it is approved first and the approved PDF is posted to them. Crew can only mark sent, and only an approved quote.",
  inputSchema: z.object({
    quoteId: z.string(),
    outcome: z.enum(["sent", "won", "lost", "void"]),
  }),
  async execute({ quoteId, outcome }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      if (outcome !== "sent" && !isPrivileged(caller.role)) {
        return { error: "NOT_PRIVILEGED: Only the owner or an admin can mark a quote won, lost, or void." };
      }
      const summary = plain(await setQuoteOutcome(quoteId, outcome, caller));
      // A won quote is work to schedule: the reply offers to book it unless they already said when.
      return outcome === "won"
        ? { ...summary, next: "Unless they already said when, offer in one line to schedule it: ask the day, time, and who goes, then book_visit with this quoteId." }
        : summary;
    } catch (error) {
      return toolError(error);
    }
  },
});
