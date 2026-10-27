import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { confirmText, rescheduleVisit, visitForTool } from "../../../../core/scheduling";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  approval: privilegedOnly("move visits or change who goes"),
  description:
    "Move a visit, change how long it is, or change who goes. Pass only what changes; the rest stays. day is as the member said it (YYYY-MM-DD, today, tomorrow, or a weekday) and time is 24-hour HH:MM, in the business's time zone. memberIds replaces the whole crew. Find the visitId with read_schedule. Owners and admins only. Whoever is on it, before or after, gets a text. Reply with confirmText.",
  inputSchema: z.object({
    visitId: z.string(),
    day: z.string().optional(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "24-hour HH:MM").optional(),
    durationMinutes: z.number().int().min(15).max(960).optional(),
    memberIds: z.array(z.string()).min(1).max(6).optional(),
    bufferBeforeMinutes: z.number().int().min(0).max(480).optional(),
    bufferAfterMinutes: z.number().int().min(0).max(480).optional(),
    notes: z.string().max(4000).optional(),
    reason: z.string().max(500).optional().describe("The member's words for why, if they said."),
    allowOutsideHours: z.boolean().optional(),
    offsetMinutes: z.number().int().optional(),
  }),
  async execute({ notes, ...input }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const moved = await rescheduleVisit(caller, { ...input, visitNotes: notes });
      return plain({
        visit: visitForTool(moved.visit, moved.timeZone, caller.language),
        was: visitForTool(moved.previous, moved.timeZone, caller.language).line,
        crewTexted: moved.notified,
        confirmText: confirmText("moved", moved.visit, moved.timeZone, caller.language),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
