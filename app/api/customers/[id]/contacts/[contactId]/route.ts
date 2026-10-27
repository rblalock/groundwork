import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { contactBodySchema, removeContactFromApp, saveContactFromApp } from "@/lib/pages/customers";

type Params = { params: Promise<{ id: string; contactId: string }> };

/** An owner or admin changes one of a customer's contacts. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const body = contactBodySchema.parse(await request.json().catch(() => null));
  const { id, contactId } = await params;
  return Response.json({ customer: await saveContactFromApp(caller, id, contactId, body) });
});

/** An owner or admin removes a contact; the customer's history keeps it. */
export const DELETE = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const { expectedRevision } = z.object({ expectedRevision: z.number().int().min(1) }).strict().parse(await request.json().catch(() => null));
  const { id, contactId } = await params;
  return Response.json({ customer: await removeContactFromApp(caller, id, contactId, expectedRevision) });
});
