import { requirePrivileged, route } from "@/lib/guards";
import { voidFromApp } from "@/lib/pages/invoices";

/** An owner or admin voids an invoice with no payments on it. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  return Response.json({ invoice: await voidFromApp(caller, (await params).id) });
});
