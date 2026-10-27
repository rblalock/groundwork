import { defineTool } from "eve/tools";
import { z } from "zod";
import { customerForTool, searchCustomers } from "../../../../core/customers";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Look up saved customers by name, phone, email, contact, or property address. Use it before saving a customer, and when a member mentions someone or a place you may already know. Each comes with their contacts (the people to reach, the preferred one first) and properties. Archived customers aren't listed.",
  inputSchema: z.object({ query: z.string().min(1) }),
  async execute({ query }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const customers = await searchCustomers(caller.orgId, query);
      return plain({ customers: customers.map(customerForTool) });
    } catch (error) {
      return toolError(error);
    }
  },
});
