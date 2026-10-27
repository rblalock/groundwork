import { requireMember, route } from "@/lib/guards";
import { customerPatchSchema, updateCustomerFromApp } from "@/lib/pages/customers";

/** An owner or admin edits a customer's details or adds an address, from the revision the page showed. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const patch = customerPatchSchema.parse(await request.json().catch(() => null));
  const customer = await updateCustomerFromApp(caller, (await params).id, patch);
  return Response.json({ customer });
});
