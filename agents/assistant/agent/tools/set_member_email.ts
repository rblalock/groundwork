import { defineTool } from "eve/tools";
import { z } from "zod";
import { setForwardingEmail } from "../../../../core/team";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Ask for the email address a member forwards emails from (\"my email is pat@example.com\"), so the emails they forward to the business's address reach you. Without memberId it's the member texting. Someone else's only for someone below them: the owner sets admins' and crew's, an admin crew's; nobody sets an owner's but that owner. It doesn't turn on yet: the member gets a code by text (codeTexted), and forwarding from that address starts once they send a new email (not a reply or forward) to the business's address from it with just the code as the subject. You never see the code; tell them in one line to check their texts for it. Pass an empty email to clear it. Only an address they typed; never guess one.",
  inputSchema: z.object({
    email: z.string().max(200).describe("The address exactly as they typed it, or empty to clear it."),
    memberId: z.string().optional().describe("Someone else's id from read_business; owners and admins only."),
  }),
  async execute({ email, memberId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const { member, pending, codeTexted } = await setForwardingEmail(caller, memberId ?? caller.memberId, email.trim() ? email : null);
      // The code stays out of the conversation: it's texted to the member on its own.
      return plain({
        member: { id: member.id, name: member.name, email: member.email },
        pending: pending && { address: pending.address, inbox: pending.inbox, expiresAt: pending.expiresAt },
        codeTexted,
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
