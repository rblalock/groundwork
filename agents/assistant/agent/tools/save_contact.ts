import { defineTool } from "eve/tools";
import { z } from "zod";
import { contactView, customerForTool, saveContact } from "../../../../core/customers";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Add a person to reach about a customer, or change one: the customer themself, or someone like a tenant, a property manager, or a spouse. Find the customer and their contacts with find_customer first. Omit contactId to add someone (name required); pass it to change them with only what changes. role is the member's own word for who they are. Phones and emails are added and removed by value (\"her new number is …, drop the old one\" adds one and removes the other). preferred makes them the one quotes and emails go to first. Only facts the member stated. Crew change only the customers they added or work with.",
  inputSchema: z.object({
    customerId: z.string().min(1),
    contactId: z.string().optional(),
    name: z.string().optional(),
    role: z.string().nullable().optional().describe("Who they are to the customer, in the member's words. Null clears it."),
    addPhones: z.array(z.string()).optional(),
    removePhones: z.array(z.string()).optional(),
    addEmails: z.array(z.string()).optional(),
    removeEmails: z.array(z.string()).optional(),
    preferred: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    try {
      // Every contact belongs to a customer already on record, so any change to one waits for the member.
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const { customer, contact } = await saveContact(caller.orgId, input, caller.memberId);
      return plain({ contact, customer: customerForTool(customer), contacts: customer.contacts.map(contactView) });
    } catch (error) {
      return toolError(error);
    }
  },
});
