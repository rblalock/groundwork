import { defineTool } from "eve/tools";
import { z } from "zod";
import { removeTeamMember } from "../../../../core/team";
import { privilegedOnly } from "../../../../core/policies";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Remove someone from the team (\"remove Carlos\"). Their phone stops reaching you right away. Find their id in read_business members. Only someone below the member texting: the owner removes admins and crew, an admin crew. The last owner cannot be removed.",
  inputSchema: z.object({ memberId: z.string() }),
  approval: privilegedOnly("remove people"),
  async execute({ memberId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const member = await removeTeamMember(caller, memberId);
      return plain({ member: { id: member.id, name: member.name, role: member.role, status: member.status } });
    } catch (error) {
      return toolError(error);
    }
  },
});
