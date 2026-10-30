import { defineTool } from "eve/tools";
import { z } from "zod";
import { findAvailability, slotLines } from "../../../../core/scheduling";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Find times a crew can take a visit of durationMinutes (default 60), inside their working hours and around their visits and time off. Advisory: it holds nothing, and book_visit checks again. Use it when the member asks when someone is free or when to fit a job in, or when a time they asked for is taken. With memberIds it's that crew; without, each member on their own. Pass reschedulingVisitId when moving that visit, so its own time counts as free. Pass the work (quoteId, jobId, or propertyId): the buffers are then the drive from the crew's stop before (or the yard) and on to the next stop (or back), and the code ranks the slots: those that keep the crew's day under the business's capacity first, then the least driving added to their day, then the earliest. Send `lines` as they are: two or three of the best, each with who and the minutes of driving it adds, and \"(day would be over capacity)\" when it doesn't fit. Never rank or work out minutes yourself. driveEstimated false means a place couldn't be placed and no drive was held; say so. Crew can only look up themselves.",
  inputSchema: z.object({
    memberIds: z.array(z.string()).min(1).max(6).optional().describe("The crew, from read_business. Omit to look at each member on their own."),
    day: z.string().default("today").describe("The first day to look: YYYY-MM-DD, today, tomorrow, or a weekday name."),
    days: z.number().int().min(1).max(14).default(5),
    durationMinutes: z.number().int().min(15).max(960).default(60),
    bufferBeforeMinutes: z.number().int().min(0).max(480).optional(),
    bufferAfterMinutes: z.number().int().min(0).max(480).optional(),
    reschedulingVisitId: z.string().optional(),
    quoteId: z.string().optional(),
    jobId: z.string().optional(),
    propertyId: z.string().optional().describe("Where the work is, when there's no quote or job yet."),
  }),
  async execute({ memberIds, day, days, durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, reschedulingVisitId, quoteId, jobId, propertyId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const found = await findAvailability(caller, {
        memberIds,
        from: day,
        days,
        durationMinutes,
        bufferBeforeMinutes,
        bufferAfterMinutes,
        reschedulingVisitId,
        quoteId,
        jobId,
        propertyId,
        limit: 40,
      });
      return plain({
        timeZone: found.timeZone,
        durationMinutes: found.durationMinutes,
        advisory: true,
        driveEstimated: found.driveEstimated,
        // The best for each crew and day, in rank order: what to offer.
        lines: slotLines(found.slots, found.timeZone, caller.language),
        // Best first.
        slots: found.slots.map(({ date, start, end, offsetMinutes, crew, addedDriveMinutes, fits, driveFromPreviousMinutes, driveToNextMinutes }) => ({
          date,
          start,
          end,
          offsetMinutes,
          memberIds: crew.map((c) => c.memberId),
          crew: crew.map((c) => c.name).join(", "),
          ...(addedDriveMinutes !== null ? { addedDriveMinutes } : {}),
          fits,
          ...(driveFromPreviousMinutes !== null ? { driveFromPreviousMinutes } : {}),
          ...(driveToNextMinutes !== null ? { driveToNextMinutes } : {}),
        })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
