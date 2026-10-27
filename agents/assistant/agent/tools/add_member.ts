import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Member } from "../../../../core/members";
import { privilegedOnly } from "../../../../core/policies";
import { addTeamMember } from "../../../../core/team";
import { languageSchema } from "../../../../core/tool-schemas";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Add a crew member or admin by phone (\"add Carlos 305-555-0142\", \"as admin\"). Registers the phone and posts a short invite to you, the person asking, as its own message for you to forward: the new person has to text the line first. Never text the new person yourself. Adding a phone that is already on the team returns that member, and a role you pass changes theirs (roleChanged); an owner keeps the owner role (roleUnchanged). A removed member comes back. An admin adds and changes crew only; the owner admins too. If invitePosted is false, put the invite text in your reply so it can be forwarded.",
  inputSchema: z.object({
    name: z.string().min(1).describe("Their name as given."),
    phone: z.string().min(1),
    role: z
      .enum(["member", "admin"])
      .optional()
      .describe("member is crew; admin can also approve and change prices. Pass it only when stated; a new person defaults to member."),
    language: languageSchema.optional().describe("Only when stated, like \"he speaks Spanish\"."),
  }),
  approval: privilegedOnly("add people"),
  async execute({ name, phone, role, language }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const added = await addTeamMember(caller, { name, phone, role, language }, { postInvite: true });
      const roleChange =
        added.roleChange === "changed" ? { roleChanged: true } : added.roleChange === "unchanged_owner" ? { roleUnchanged: true } : {};
      return plain({
        member: publicMember(added.member),
        alreadyActive: added.alreadyActive,
        ...roleChange,
        assignedLine: added.assignedLine,
        invitePosted: added.invitePosted,
        // Not posted: the reply carries it, so it can still be forwarded.
        ...(added.invite && !added.invitePosted ? { invite: added.invite } : {}),
      });
    } catch (error) {
      return toolError(error);
    }
  },
});

function publicMember(member: Member) {
  return { id: member.id, name: member.name, role: member.role, language: member.language, status: member.status };
}
