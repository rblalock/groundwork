import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { callingThread, isJobAuth, jobIdFor, openJob, runJobTurn } from "../../../../core/jobs";
import { relayGuidance } from "../../../../core/job-guidance";
import { isEmailTurn, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

// Thread only: inside a job (the assistant driving it, or the member chatting in it on the web) this
// resolves to no tool, so a job can't open jobs. Nor on a forwarded email's turn: the job's own turns
// would run without the email's mark (`refuseFromEmail`). `execute` checks both again.
export default defineDynamic({
  events: {
    "turn.started": (_event, resolve) =>
      isJobAuth(resolve.session.auth.current) || isEmailTurn(resolve.session.auth.current)
        ? null
        : defineTool({
            availableInSubagents: false,
            description:
              "Open a job: a separate conversation for one piece of multi-step work (a quote, a customer's issue) that runs on its own and keeps the member's thread a clean index. Pass a short title (the address, customer, or their phrase for the work), the member's notes verbatim, and what it's about: for work on an existing quote, its quoteId (find it with list_quotes), and the customerId when you know it. The job takes its first turn with those notes and returns its reply for you to relay.",
            inputSchema: z.object({
              title: z.string().min(1).max(160),
              notes: z.string().min(1).max(20_000).describe("The member's words for the work, verbatim."),
              quoteId: z.string().min(1).optional().describe("Only an existing quote id from a tool result."),
              customerId: z.string().min(1).optional().describe("Only an existing customer id from a tool result."),
            }),
            async execute(input, ctx) {
              try {
                refuseFromEmail(ctx);
                const caller = await requireCaller(ctx);
                const thread = await callingThread(caller, ctx.session.auth.current, ctx.session.id);
                const job = await openJob(caller, {
                  id: jobIdFor(ctx.session.id, ctx.callId),
                  thread,
                  title: input.title,
                  quoteId: input.quoteId,
                  customerId: input.customerId,
                });
                const outcome = await runJobTurn(caller, job.id, input.notes, {
                  operationId: `${ctx.session.id}:${ctx.callId}`,
                  signal: ctx.abortSignal,
                });
                return { jobId: job.id, title: job.title, status: outcome.status, reply: outcome.reply, guidance: relayGuidance(outcome.status) };
              } catch (error) {
                return toolError(error);
              }
            },
          }),
  },
});
