import { defineTool } from "eve/tools";
import { z } from "zod";
import { findAvailability } from "../../../../core/scheduling";
import { dayText, timeText } from "../../../../core/scheduling-time";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Find open times when all the given crew are free for a visit of durationMinutes (default 60), inside their working hours and around their visits and time off, in 15-minute steps. Advisory: it holds nothing, and book_visit checks again. Use it when the member asks when someone is free, or when a time they asked for is taken. Pass reschedulingVisitId when moving that visit, so its own time counts as free. Pass the work (quoteId, jobId, or propertyId): the buffers are then the drive from the crew's stop before (or the yard) and on to the next stop (or back), worked out by the code. driveEstimated false means a place couldn't be placed and no drive was held; say so. Crew can only look up themselves. Offer two or three times, not the whole list.",
  inputSchema: z.object({
    memberIds: z.array(z.string()).min(1).max(6).describe("From read_business."),
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
      // Grouped by day, so the model offers a spread instead of the first few minutes of one morning.
      const byDay = new Map<string, string[]>();
      for (const slot of found.slots) byDay.set(slot.date, [...(byDay.get(slot.date) ?? []), timeText(slot.startAt, found.timeZone, caller.language)]);
      return plain({
        timeZone: found.timeZone,
        durationMinutes: found.durationMinutes,
        advisory: true,
        driveEstimated: found.driveEstimated,
        days: [...byDay.entries()].map(([date, starts]) => ({ date, day: dayText(date, caller.language), starts })),
        slots: found.slots.map(({ date, start, end, offsetMinutes, driveFromPreviousMinutes, driveToNextMinutes }) => ({
          date,
          start,
          end,
          offsetMinutes,
          ...(driveFromPreviousMinutes !== null ? { driveFromPreviousMinutes } : {}),
          ...(driveToNextMinutes !== null ? { driveToNextMinutes } : {}),
        })),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
