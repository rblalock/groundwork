import { defineTool } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { getProfile } from "../../../../core/profile";
import { setWorkHours, visitForTool } from "../../../../core/scheduling";
import { clockSchema } from "../../../../core/scheduling-time";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  approval: privilegedOnly("set working hours"),
  description:
    "Set when the crew work, which is what visits are booked into: the business's hours (no memberId), or one member's own (memberId). hours is the whole week, one entry per stretch: day 0 is Sunday to 6 Saturday, start and end 24-hour HH:MM (\"weekdays 7 to 4\" is days 1-5, 07:00-16:00). Pass hours null with a memberId to put them back on the business's hours. Owners and admins only. Visits already booked stay; outsideHours lists any that now fall outside, to mention.",
  inputSchema: z.object({
    memberId: z.string().optional(),
    hours: z
      .array(z.object({ day: z.number().int().min(0).max(6), start: clockSchema, end: clockSchema }))
      .max(35)
      .nullable(),
  }),
  async execute({ memberId, hours }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const saved = await setWorkHours(caller, { memberId, hours });
      const { timeZone } = await getProfile(caller.orgId);
      return plain({ hours: saved.hours, outsideHours: saved.outsideHours.map((v) => visitForTool(v, timeZone, caller.language).line) });
    } catch (error) {
      return toolError(error);
    }
  },
});
