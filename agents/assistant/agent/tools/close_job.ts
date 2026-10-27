import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { callingThread, isJobAuth, setJobStatus } from "../../../../core/jobs";
import { refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

// Thread only, like start_job.
export default defineDynamic({
  events: {
    "turn.started": (_event, resolve) =>
      isJobAuth(resolve.session.auth.current)
        ? null
        : defineTool({
            availableInSubagents: false,
            description:
              "Mark one of the member's jobs done when its work is finished or they say so, or archived when they want it put away. A done job can still be continued later; an archived one can't.",
            inputSchema: z.object({ jobId: z.string().min(1), status: z.enum(["done", "archived"]).optional() }),
            async execute(input, ctx) {
              try {
                refuseFromEmail(ctx);
                const caller = await requireCaller(ctx);
                await callingThread(caller, ctx.session.auth.current, ctx.session.id);
                const job = await setJobStatus(caller, input.jobId, input.status ?? "done");
                return { jobId: job.id, title: job.title, status: job.status };
              } catch (error) {
                return toolError(error);
              }
            },
          }),
  },
});
