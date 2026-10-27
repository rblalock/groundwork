import { defineTool } from "eve/tools";
import { z } from "zod";
import { updateTeamMember } from "../../../../core/team";
import { languageSchema } from "../../../../core/tool-schemas";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Change a team member's name, language, or role (\"call me Pat\", \"Carlos reads Spanish\", \"make Ana an admin\", \"Ana is crew now\"). Without memberId it's the member texting. Anyone changes their own name and language; the owner or an admin changes them for someone below them. Only the owner changes roles, between admin and crew (member), never their own, and the owner's role never changes here. Find ids in read_business members. Pass only what they said.",
  inputSchema: z.object({
    memberId: z.string().optional().describe("Someone else's id from read_business; omit for the member texting."),
    name: z.string().trim().min(1).max(100).optional(),
    language: languageSchema.optional(),
    role: z.enum(["member", "admin"]).optional().describe("member is crew."),
  }),
  async execute({ memberId, ...update }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const member = await updateTeamMember(caller, memberId ?? caller.memberId, update);
      return plain({ member: { id: member.id, name: member.name, role: member.role, language: member.language } });
    } catch (error) {
      return toolError(error);
    }
  },
});
