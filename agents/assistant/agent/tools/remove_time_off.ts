import { defineTool } from "eve/tools";
import { z } from "zod";
import { removeTimeOff } from "../../../../core/scheduling";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description: "Take time off back off the schedule, by its timeOffId from read_schedule. Crew can remove only their own.",
  inputSchema: z.object({ timeOffId: z.string() }),
  async execute({ timeOffId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const block = await removeTimeOff(caller, timeOffId);
      return plain({ removed: block.id });
    } catch (error) {
      return toolError(error);
    }
  },
});
