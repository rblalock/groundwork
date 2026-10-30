import { defineTool } from "eve/tools";
import { z } from "zod";
import { declareDelay } from "../../../../core/crew-phone";
import { visitForTool } from "../../../../core/scheduling";
import { wallClock } from "../../../../core/scheduling-time";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "The crew are running late: \"running 30 late\" is minutes 30, \"an extra hour here\" is 60, \"back on time\" is 0 (clears it). Sets the delay on the stop they're on, else their next one (or visitId when they name one), and the code re-plans the rest of today: shifts lists the stops they'd now reach late, atRisk says the day runs past its end plus the business's grace, which the owner sees on the schedule. Crew only on visits they're on; owners and admins any. Moves no visit and texts no customer. Reply with text as it is.",
  inputSchema: z.object({
    minutes: z.number().int().min(0).max(480),
    visitId: z.string().optional(),
  }),
  async execute({ minutes, visitId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const delayed = await declareDelay(caller, { minutes, visitId });
      const clock = (at: Date | null) => (at ? wallClock(at, delayed.timeZone).time : null);
      return plain({
        visit: visitForTool(delayed.visit, delayed.timeZone, caller.language),
        delayMinutes: delayed.visit.delayMinutes,
        shifts: delayed.shifts.map((s) => ({ visitId: s.visitId, title: s.title, arriveAbout: clock(s.arriveAbout), lateMinutes: s.lateMinutes })),
        backAtYardAt: clock(delayed.backAbout),
        atRisk: delayed.atRisk,
        text: delayed.text,
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
