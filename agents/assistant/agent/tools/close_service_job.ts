import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { getProfile } from "../../../../core/profile";
import { invoicesForJobs } from "../../../../core/invoices";
import { closeServiceJob, visitForTool } from "../../../../core/scheduling";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  approval: privilegedOnly("close work"),
  description:
    "Close a piece of work (not a job conversation): completed when it's all done (\"Oak St is finished\"), which marks its visits that have started done, or cancelled. Visits still ahead are refused with VISITS_AHEAD: ask whether to cancel them, and only then pass cancelUpcomingVisits. Owners and admins only. Find the jobId with read_schedule or the quote.",
  inputSchema: z.object({
    jobId: z.string(),
    status: z.enum(["completed", "cancelled"]),
    cancelUpcomingVisits: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  }),
  async execute(input, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const closed = await closeServiceJob(caller, input);
      const { timeZone } = await getProfile(caller.orgId);
      const invoiced = closed.job.status === "completed" ? (await invoicesForJobs(caller.orgId, [closed.job.id])).get(closed.job.id) : undefined;
      return plain({
        job: { jobId: closed.job.id, title: closed.job.title, status: closed.job.status },
        visitsMarkedDone: closed.completedVisits,
        visitsCancelled: closed.cancelledVisits.map((v) => visitForTool(v, timeZone, caller.language).line),
        crewTexted: closed.notified,
        // Finished work is work to bill: the reply offers to invoice it, unless it already is.
        ...(closed.job.status === "completed"
          ? invoiced
            ? { invoice: invoiced }
            : { next: "Offer in one line to invoice it now (create_invoice with this serviceJobId, send true when they say yes)." }
          : {}),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
