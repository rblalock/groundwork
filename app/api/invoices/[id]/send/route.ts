import { requirePrivileged, route } from "@/lib/guards";
import { sendFromApp } from "@/lib/pages/invoices";

/** An owner or admin sends the invoice: its PDF goes to their texts to forward. Customers aren't texted. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const { invoice, posted } = await sendFromApp(caller, (await params).id);
  return Response.json({ invoice, posted });
});
