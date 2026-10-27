import { requirePrivileged, route } from "@/lib/guards";
import { mergeBodySchema, mergeFromApp } from "@/lib/pages/customers";

/** An owner or admin merges another customer into this one: everything moves here, and the other is archived. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const body = mergeBodySchema.parse(await request.json().catch(() => null));
  const result = await mergeFromApp(caller, (await params).id, body);
  return Response.json({ customerId: result.customer.id, merged: result.merged, moved: result.moved });
});
