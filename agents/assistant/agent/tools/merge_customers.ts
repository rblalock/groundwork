import { defineTool } from "eve/tools";
import { z } from "zod";
import { confirmedEarlier, confirmTurn } from "../../../../core/confirmations";
import { customerFootprint, customerForTool, getCustomer, mergeCustomers } from "../../../../core/customers";
import { isPrivileged } from "../../../../core/members";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Merge two saved customers that are the same person or business (\"Jane Smith and J. Smith are the same\"): everything on mergeCustomerId (quotes, properties, invoices, work, notes, contacts) moves to keepCustomerId, and the merged one is archived. Find both with find_customer first; when more than two could be meant, ask which. Keep the one with the fuller name or more on record unless the member says otherwise. It always asks first: the first call merges nothing and returns status confirm with both customers and what would move, so ask the member in one line to confirm, naming both and which name stays. Only after they say yes, in their next message, call it again with the same two ids to merge. Owners and admins only.",
  inputSchema: z.object({
    keepCustomerId: z.string().min(1).describe("The customer that stays."),
    mergeCustomerId: z.string().min(1).describe("The duplicate, merged into the one that stays."),
  }),
  async execute({ keepCustomerId, mergeCustomerId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      if (!isPrivileged(caller.role)) throw new Error("NOT_PRIVILEGED");
      if (keepCustomerId === mergeCustomerId) throw new Error("SAME_CUSTOMER");
      const [keep, merge] = await Promise.all([getCustomer(caller.orgId, keepCustomerId), getCustomer(caller.orgId, mergeCustomerId)]);
      if (!keep || !merge) throw new Error("CUSTOMER_NOT_FOUND");
      if (keep.archivedAt || merge.archivedAt) throw new Error("CUSTOMER_ARCHIVED");
      const go = await confirmedEarlier({
        orgId: caller.orgId,
        memberId: caller.memberId,
        action: "merge_customers",
        subject: `${keepCustomerId}<${mergeCustomerId}`,
        turn: confirmTurn(ctx),
      });
      if (!go) {
        return plain({
          status: "confirm",
          keep: customerForTool(keep),
          merge: customerForTool(merge),
          wouldMove: await customerFootprint(caller.orgId, mergeCustomerId),
          note: "Nothing was merged. Ask the member to confirm; merge only when their next message says yes.",
        });
      }
      const result = await mergeCustomers(caller.orgId, { keepId: keepCustomerId, mergeId: mergeCustomerId }, caller.memberId);
      return plain({ status: "merged", customer: customerForTool(result.customer), merged: result.merged, moved: result.moved });
    } catch (error) {
      return toolError(error);
    }
  },
});
