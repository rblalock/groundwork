import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { getProfile } from "../../../../core/profile";
import { RECURRING } from "../../../../core/recurrence";
import { jobRecurrenceText, setRecurrence, visitForTool } from "../../../../core/scheduling";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  approval: privilegedOnly("change how work repeats"),
  description:
    "Change how open work repeats: weekly, biweekly (every other week), or monthly, from its visits' weekday and time; or none to stop it repeating (\"stop the weekly mowing at Oak St\"). Owners and admins only. Find the jobId with read_schedule. The visits already booked stay: when it stops and nextVisit is there, ask in one line whether to cancel that one too (change_visit_status). Reply with recurring, or that it no longer repeats.",
  inputSchema: z.object({
    jobId: z.string(),
    recurring: z.enum([...RECURRING, "none"]),
  }),
  async execute(input, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const { job, nextVisit } = await setRecurrence(caller, input);
      const { timeZone } = await getProfile(caller.orgId);
      return plain({
        job: { jobId: job.id, title: job.title, status: job.status },
        recurring: jobRecurrenceText(job, timeZone, caller.language),
        ...(nextVisit ? { nextVisit: visitForTool(nextVisit, timeZone, caller.language).line } : {}),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
