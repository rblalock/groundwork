import { defineTool } from "eve/tools";
import { z } from "zod";
import { getProfile } from "../../../../core/profile";
import { changeVisitStatus, visitForTool } from "../../../../core/scheduling";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Mark a visit done (completed), cancel it (cancelled), or confirm one that was pencilled in (scheduled). Anyone on the team can mark a visit done once its day has come, theirs or another crew's (\"done at Oak St\"), with notes on how it went; cancelling and confirming are for owners and admins, and a cancelled visit's crew get a text. When openVisitsOnJob is 0 after marking done, ask in one line whether the work is finished, and if so close_service_job.",
  inputSchema: z.object({
    visitId: z.string(),
    status: z.enum(["completed", "cancelled", "scheduled"]),
    notes: z.string().max(4000).optional().describe("Replaces the visit's notes."),
    reason: z.string().max(500).optional(),
  }),
  async execute({ visitId, status, notes, reason }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const changed = await changeVisitStatus(caller, { visitId, status, visitNotes: notes, reason });
      const { timeZone } = await getProfile(caller.orgId);
      return plain({ visit: visitForTool(changed.visit, timeZone, caller.language), openVisitsOnJob: changed.openVisitsOnJob, crewTexted: changed.notified });
    } catch (error) {
      return toolError(error);
    }
  },
});
