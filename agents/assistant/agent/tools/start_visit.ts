import { defineTool } from "eve/tools";
import { z } from "zod";
import { startStop } from "../../../../core/crew-phone";
import { visitForTool } from "../../../../core/scheduling";
import { wallClock } from "../../../../core/scheduling-time";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "The crew are on site: \"here\", \"on site\", \"starting Oak St\". Marks today's visit started now, and the rest of their day re-plans from it. Leave visitId out for the member's next stop; pass it (from next_stop or read_schedule) when they name another. Crew start only visits they're on; owners and admins any. It doesn't mark anything done: that's change_visit_status. Send text as it is.",
  inputSchema: z.object({
    visitId: z.string().optional(),
  }),
  async execute({ visitId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const started = await startStop(caller, { visitId });
      return plain({
        visit: visitForTool(started.visit, started.timeZone, caller.language),
        alreadyStarted: started.alreadyStarted,
        startedAt: started.visit.startedAt ? wallClock(started.visit.startedAt, started.timeZone).time : null,
        doneAbout: started.doneAbout ? wallClock(started.doneAbout, started.timeZone).time : null,
        next: started.next,
        notMarkedDone: started.stillOpen,
        text: started.text,
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
