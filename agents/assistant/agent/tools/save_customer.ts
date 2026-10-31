import { defineTool } from "eve/tools";
import { z } from "zod";
import { customerForTool, saveCustomer } from "../../../../core/customers";
import { languageSchema } from "../../../../core/tool-schemas";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Save a customer the member told you about, or add to one you found with find_customer (pass customerId). Only facts the member stated. A phone or email is added to their preferred contact (or contactId's); for another person, like a tenant, use save_contact. An address becomes one of their properties; with propertyId (from find_customer) it corrects that property's address instead (\"her address is 414 Oak St, not 412\"). language is the customer's (\"she speaks Spanish\" → es) and sets the PDF language. notes is the customer's own short note; procedures, site notes, and gate codes go in save_note. Crew add new customers, and change only the ones they added or work with (their quotes and visits).",
  inputSchema: z.object({
    customerId: z.string().optional(),
    name: z.string().min(1).optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    language: languageSchema.optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
    contactId: z.string().optional().describe("The contact a phone or email belongs to, from find_customer."),
    propertyId: z.string().optional().describe("The property whose address `address` replaces, from find_customer."),
  }),
  async execute(input, ctx) {
    try {
      // Saving a new customer from an email is fine; changing one on record waits for the member.
      if (input.customerId || input.contactId || input.propertyId) refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const c = await saveCustomer(caller.orgId, input, caller.memberId);
      return plain({ customer: customerForTool(c) });
    } catch (error) {
      return toolError(error);
    }
  },
});
