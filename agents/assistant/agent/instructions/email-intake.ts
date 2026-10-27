import { defineDynamic, defineInstructions } from "eve/instructions";
import { pendingClaimOf } from "../../../../core/email-claims";
import { findMemberById, resolveCaller } from "../../../../core/members";
import { getOrganization } from "../../../../core/organizations";

// Forwarding emails is offered only once the business has its inbox (core/email-intake.ts), and
// the assistant learns the address to give out. Resolved every turn: a super admin can make the inbox
// while a member's thread is going.
export default defineDynamic({
  events: {
    "turn.started": async (_event, resolve) => {
      const caller = await resolveCaller(resolve.session.auth.current).catch(() => null);
      const org = caller ? await getOrganization(caller.orgId) : null;
      if (!caller || !org?.inboxAddress) return null;
      const saved = (await findMemberById(caller.orgId, caller.memberId))?.email;
      const pending = await pendingClaimOf(caller.orgId, caller.memberId);
      return defineInstructions({
        content:
          `The business's email address for forwarding is ${org.inboxAddress}. A member's forwarded emails reach you only from the address confirmed for them (set_member_email asks for one; they confirm it by sending a new email from it with just the texted code as the subject); ` +
          (saved ? `this member's is ${saved}. ` : "this member has none on yet, so when they ask where to send emails, also ask which address they'll forward from. ") +
          (pending ? `${pending.address} is waiting on its code, which was texted to them. ` : "") +
          "When asked what you can do, also list handling emails they forward.",
      });
    },
  },
});
