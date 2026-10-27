import { defineTool } from "eve/tools";
import { z } from "zod";
import { confirmedEarlier, confirmTurn } from "../../../../core/confirmations";
import { archiveCustomer, customerFootprint, getCustomer } from "../../../../core/customers";
import { isPrivileged } from "../../../../core/members";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Archive a customer when the owner or an admin asks to delete or remove one: it leaves the customer lists and searches, and its quotes, invoices, work, and notes stay on record. It always asks first: the first call archives nothing and returns status confirm with what is on record, so ask the member in one line whether to archive them (naming the customer and what stays). Only after they say yes, in their next message, call it again with the same customerId to archive. Owners and admins only.",
  inputSchema: z.object({ customerId: z.string().min(1) }),
  async execute({ customerId }, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      if (!isPrivileged(caller.role)) throw new Error("NOT_PRIVILEGED");
      const customer = await getCustomer(caller.orgId, customerId);
      if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
      if (customer.archivedAt) throw new Error("CUSTOMER_ARCHIVED");
      const go = await confirmedEarlier({
        orgId: caller.orgId,
        memberId: caller.memberId,
        action: "archive_customer",
        subject: customerId,
        turn: confirmTurn(ctx),
      });
      if (!go) {
        return plain({
          status: "confirm",
          customer: { id: customer.id, name: customer.name },
          onRecord: await customerFootprint(caller.orgId, customerId),
          note: "Nothing was archived. Ask the member to confirm; archive only when their next message says yes.",
        });
      }
      const { customer: archived, kept } = await archiveCustomer(caller.orgId, customerId, caller.memberId);
      return plain({ status: "archived", customer: { id: archived.id, name: archived.name }, kept });
    } catch (error) {
      return toolError(error);
    }
  },
});
