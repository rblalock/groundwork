import { defineTool } from "eve/tools";
import { z } from "zod";
import { getProfile } from "../../../../core/profile";
import { addTimeOff, timeOffText } from "../../../../core/scheduling";
import { clockSchema } from "../../../../core/scheduling-time";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Put time off on the schedule, so nobody books into it: for a member (memberId), or with no memberId the whole business (a holiday). All day unless start and end (24-hour HH:MM) are given; endDay makes it several days. day and endDay are YYYY-MM-DD, today, tomorrow, or a weekday name. Crew can add their own (\"I'm off Friday\"); owners and admins anyone's. Refused with HAS_VISITS when they have visits then.",
  inputSchema: z.object({
    memberId: z.string().optional(),
    day: z.string().min(1),
    endDay: z.string().optional(),
    start: clockSchema.optional(),
    end: clockSchema.optional(),
    reason: z.string().max(200).optional(),
  }),
  async execute(input, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const block = await addTimeOff(caller, input);
      const { timeZone } = await getProfile(caller.orgId);
      return plain({ timeOffId: block.id, who: block.memberName ?? "the whole business", when: timeOffText(block, timeZone, caller.language) });
    } catch (error) {
      return toolError(error);
    }
  },
});
