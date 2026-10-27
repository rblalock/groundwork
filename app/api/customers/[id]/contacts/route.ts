import { requireMember, route } from "@/lib/guards";
import { contactBodySchema, saveContactFromApp } from "@/lib/pages/customers";

/** An owner or admin adds someone to reach about a customer. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const body = contactBodySchema.parse(await request.json().catch(() => null));
  const customer = await saveContactFromApp(caller, (await params).id, undefined, body);
  return Response.json({ customer });
});
