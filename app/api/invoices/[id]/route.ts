import { requirePrivileged, route } from "@/lib/guards";
import { invoiceFor, updateFromApp, updateSchema } from "@/lib/pages/invoices";

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (request: Request, { params }: Params) => {
  const caller = await requirePrivileged(request.headers);
  return Response.json({ invoice: await invoiceFor(caller, (await params).id) });
});

/** An owner or admin changes a draft's lines, notes, or due date. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const caller = await requirePrivileged(request.headers);
  const input = updateSchema.parse(await request.json().catch(() => null));
  return Response.json({ invoice: await updateFromApp(caller, (await params).id, input) });
});
