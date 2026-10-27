import { requirePrivileged, route } from "@/lib/guards";
import { archiveBodySchema, setArchivedFromApp } from "@/lib/pages/customers";

/** An owner or admin archives a customer (quotes and invoices stay) or brings one back. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const body = archiveBodySchema.parse(await request.json().catch(() => null));
  return Response.json({ customer: await setArchivedFromApp(caller, (await params).id, body) });
});
