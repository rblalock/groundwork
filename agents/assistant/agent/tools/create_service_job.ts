import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { getProfile } from "../../../../core/profile";
import { createServiceJob, jobRecurrenceText } from "../../../../core/scheduling";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";
import { recurringSchema } from "../../../../core/tool-schemas";

export default defineTool({
  approval: privilegedOnly("open work to schedule"),
  description:
    "Open work to schedule later, without a visit yet: from a won, sent, or approved quote (quoteId), or on its own (a title, and the customerId and propertyId when known). This is the work itself, not a job conversation (start_job). A quote has one piece of work, so calling it again returns the same one. Owners and admins only. recurring marks work that repeats; its first visit booked sets the weekday and time. When they give a day and time, use book_visit instead, which opens the work too.",
  inputSchema: z.object({
    quoteId: z.string().optional(),
    title: z.string().min(1).max(160).optional().describe("Required without a quote: the address or the member's words for the work."),
    customerId: z.string().optional(),
    propertyId: z.string().optional(),
    notes: z.string().max(4000).optional(),
    recurring: recurringSchema.optional(),
  }),
  async execute(input, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const { job, created } = await createServiceJob(caller, input);
      const recurring = jobRecurrenceText(job, (await getProfile(caller.orgId)).timeZone, caller.language);
      return plain({
        created,
        job: {
          jobId: job.id,
          title: job.title,
          status: job.status,
          quoteId: job.quoteId,
          customerName: job.customerName,
          address: job.address,
          visits: job.visits.length,
          ...(recurring ? { recurring } : {}),
        },
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
