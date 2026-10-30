import { defineTool } from "eve/tools";
import { z } from "zod";
import { nextStop } from "../../../../core/crew-phone";
import { wallClock } from "../../../../core/scheduling-time";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "The next stop on a crew member's day today, for \"next\", \"where to?\", or \"what's after this?\": its time and address, a map link, the drive from where they are (the stop they're on or the yard), the visit's notes and the site's (gate codes, dogs), and its checklist, worked out by the code from the day as it re-plans. Crew get their own; owners and admins pass memberId for someone else's (else their own). Send text as it is. next is null when no stop is left today.",
  inputSchema: z.object({
    memberId: z.string().optional().describe("Owners and admins only: whose day. Crew always get their own."),
  }),
  async execute({ memberId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const found = await nextStop(caller, { memberId });
      const clock = (at: Date | null | undefined) => (at ? wallClock(at, found.timeZone).time : null);
      const { stop, visit } = found;
      return plain({
        next: stop
          ? {
              visitId: stop.visitId,
              title: stop.title,
              address: stop.address,
              customerName: visit?.customerName ?? null,
              start: clock(stop.startAt),
              end: clock(stop.endAt),
              arriveAbout: clock(stop.plannedArriveAt),
              lateMinutes: stop.lateMinutes,
              driveMinutes: stop.legIn?.minutes ?? null,
              driveFrom: stop.legIn ? (stop.legIn.yard ? "the yard" : stop.legIn.label) : null,
              mapsUrl: found.mapsUrl,
              notes: visit?.notes ?? null,
              siteNotes: found.siteNotes,
              checklist: found.checklist,
            }
          : null,
        remainingAfter: found.remaining,
        backAtYardAt: clock(found.plan?.backAtYardAt),
        atRisk: found.plan?.atRisk ?? false,
        text: found.text,
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
