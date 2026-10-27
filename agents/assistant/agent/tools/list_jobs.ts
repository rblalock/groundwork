import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { callingThread, isJobAuth, listJobs } from "../../../../core/jobs";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

// Thread only, like start_job.
export default defineDynamic({
  events: {
    "turn.started": (_event, resolve) =>
      isJobAuth(resolve.session.auth.current)
        ? null
        : defineTool({
            availableInSubagents: false,
            description:
              "List the member's jobs, most recently active first: open ones, or all but archived. Use it to find the job a message is about before continue_job or close_job.",
            inputSchema: z.object({ include: z.enum(["open", "all"]).optional() }),
            async execute(input, ctx) {
              try {
                const caller = await requireCaller(ctx);
                await callingThread(caller, ctx.session.auth.current, ctx.session.id);
                const jobs = await listJobs(caller.orgId, caller.memberId, { include: input.include ?? "open" });
                return plain({
                  jobs: jobs.map((job) => ({
                    jobId: job.jobId,
                    title: job.title,
                    status: job.status,
                    quoteId: job.quoteId,
                    quoteTitle: job.quoteTitle,
                    customerId: job.customerId,
                    customerName: job.customerName,
                    updatedAt: job.updatedAt,
                  })),
                });
              } catch (error) {
                return toolError(error);
              }
            },
          }),
  },
});
