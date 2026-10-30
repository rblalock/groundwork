import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { bookVisit, confirmText, visitForTool } from "../../../../core/scheduling";
import { isEmailTurn, plain, requireCaller, toolError } from "../../../../core/tool-context";
import { recurringSchema } from "../../../../core/tool-schemas";

export default defineTool({
  approval: privilegedOnly("book visits"),
  description:
    "Book a visit: when the work happens and who goes. For a quote (quoteId: approved, sent, or won; its work is opened the first time), more visits on existing work (jobId), or new work with no quote (title, and customerId and propertyId when known). Owners and admins only. day is as the member said it (YYYY-MM-DD, today, tomorrow, or a weekday name like tuesday) and time is 24-hour HH:MM, both in the business's time zone: the code works out the date, so never compute it yourself. memberIds come from read_business. durationMinutes defaults to 60. Leave the buffers out unless the member gives them: the code holds the drive in from the crew's stop before (or the yard) and out to the next (or back); driveEstimated false means a place couldn't be placed, so no drive was held. A crew who don't carry what the work's price book items need is refused (MISSING_EQUIPMENT). tentative pencils it in. recurring makes the work repeat from this visit (same weekday, time, and length): each visit marked done books the next with the same crew, and visit.recurring says how it repeats. The crew booked get a text; customers never do. Reply with confirmText.",
  inputSchema: z.object({
    quoteId: z.string().optional(),
    jobId: z.string().optional(),
    title: z.string().min(1).max(160).optional(),
    customerId: z.string().optional(),
    propertyId: z.string().optional(),
    memberIds: z.array(z.string()).min(1).max(6),
    day: z.string().min(1),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "24-hour HH:MM"),
    durationMinutes: z.number().int().min(15).max(960).optional(),
    bufferBeforeMinutes: z.number().int().min(0).max(480).optional(),
    bufferAfterMinutes: z.number().int().min(0).max(480).optional(),
    notes: z.string().max(4000).optional().describe("Notes for the crew on this visit."),
    tentative: z.boolean().optional(),
    recurring: recurringSchema.optional(),
    allowOutsideHours: z.boolean().optional().describe("Only after the member confirms they want it outside the crew's hours."),
    allowMissingEquipment: z
      .boolean()
      .optional()
      .describe("Only when the owner or an admin says the crew goes anyway without what the work needs (\"Carlos will borrow the chipper\")."),
    offsetMinutes: z.number().int().optional().describe("Only for a time the clocks repeat, from the AMBIGUOUS_TIME error."),
  }),
  async execute({ notes, ...input }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      // From a forwarded email, a visit is only pencilled in, and no crew are texted: the email's words
      // mustn't reach or dispatch anyone but the member, who confirms it in a turn of their own.
      const fromEmail = isEmailTurn(ctx.session.auth.current);
      const booked = await bookVisit(caller, { ...input, visitNotes: notes, ...(fromEmail ? { tentative: true, silent: true } : {}) });
      return plain({
        visit: visitForTool(booked.visit, booked.timeZone, caller.language),
        workOpened: booked.jobCreated,
        buffers: { beforeMinutes: booked.visit.bufferBeforeMinutes, afterMinutes: booked.visit.bufferAfterMinutes },
        driveEstimated: booked.driveEstimated ?? false,
        crewTexted: booked.notified,
        confirmText: confirmText("booked", booked.visit, booked.timeZone, caller.language),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
