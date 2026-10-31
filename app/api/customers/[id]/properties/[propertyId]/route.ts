import { z } from "zod";
import { requireMember, route } from "@/lib/guards";
import { propertyBodySchema, removePropertyFromApp, savePropertyFromApp } from "@/lib/pages/customers";

type Params = { params: Promise<{ id: string; propertyId: string }> };

/** An owner or admin corrects one of a customer's addresses or its notes. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const body = propertyBodySchema.parse(await request.json().catch(() => null));
  const { id, propertyId } = await params;
  return Response.json({ customer: await savePropertyFromApp(caller, id, propertyId, body) });
});

/** An owner or admin removes an address nothing is on; the customer's history keeps it. */
export const DELETE = route(async (request: Request, { params }: Params) => {
  const caller = await requireMember(request.headers);
  const { expectedRevision } = z.object({ expectedRevision: z.number().int().min(1) }).strict().parse(await request.json().catch(() => null));
  const { id, propertyId } = await params;
  return Response.json({ customer: await removePropertyFromApp(caller, id, propertyId, expectedRevision) });
});
