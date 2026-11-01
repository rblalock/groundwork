import { defineTool } from "eve/tools";
import { z } from "zod";
import { checklistForTool, checklistOutlines, tickChecklist } from "../../../../core/checklist";
import { getProfile } from "../../../../core/profile";
import { visitForTool } from "../../../../core/scheduling";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Tick items on the work's checklist done (\"mulch is done\", \"finished the hedge\"), or untick them with undo. Anyone on the team, on any work. Pass jobId and the itemIds from read_checklist for the items they meant. Returns the list as read_checklist does. When this tick finished the list, the work's open visit from today or earlier is marked done, as change_visit_status would: visitCompleted is that visit, and openVisitsOnJob how many are still open (at 0, ask in one line whether the work is finished). A visit on a later day is never marked done; visitCompleted is then null.",
  inputSchema: z.object({
    jobId: z.string().describe("The work (sj_…)."),
    itemIds: z.array(z.string()).min(1).max(100).describe("The items meant, from read_checklist."),
    undo: z.boolean().optional().describe("Untick them instead."),
  }),
  async execute({ jobId, itemIds, undo }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const ticked = await tickChecklist(caller, { jobId, itemIds, undo });
      const { timeZone } = await getProfile(caller.orgId);
      return plain({
        jobId,
        ...checklistForTool(ticked.items, timeZone, caller.language, await checklistOutlines(caller.orgId, jobId)),
        visitCompleted: ticked.visitCompleted ? visitForTool(ticked.visitCompleted, timeZone, caller.language) : null,
        ...(ticked.visitCompleted ? { openVisitsOnJob: ticked.openVisitsOnJob } : {}),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
