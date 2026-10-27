import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { callingThread, isJobAuth, runJobTurn } from "../../../../core/jobs";
import { relayGuidance } from "../../../../core/job-guidance";
import { isEmailTurn, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

// Thread only, and not on a forwarded email's turn, like start_job.
export default defineDynamic({
  events: {
    "turn.started": (_event, resolve) =>
      isJobAuth(resolve.session.auth.current) || isEmailTurn(resolve.session.auth.current)
        ? null
        : defineTool({
            availableInSubagents: false,
            description:
              "Send the member's next message into one of their open jobs and get the job's reply to relay. Put their message in their own words. Use the jobId from the context's open jobs, list_jobs, or start_job; never guess one.",
            inputSchema: z.object({
              jobId: z.string().min(1),
              message: z.string().min(1).max(20_000).describe("The member's message, in their words."),
            }),
            async execute(input, ctx) {
              try {
                refuseFromEmail(ctx);
                const caller = await requireCaller(ctx);
                await callingThread(caller, ctx.session.auth.current, ctx.session.id);
                const outcome = await runJobTurn(caller, input.jobId, input.message, {
                  operationId: `${ctx.session.id}:${ctx.callId}`,
                  signal: ctx.abortSignal,
                });
                return {
                  jobId: outcome.job.id,
                  title: outcome.job.title,
                  status: outcome.status,
                  reply: outcome.reply,
                  guidance: relayGuidance(outcome.status),
                };
              } catch (error) {
                return toolError(error);
              }
            },
          }),
  },
});
