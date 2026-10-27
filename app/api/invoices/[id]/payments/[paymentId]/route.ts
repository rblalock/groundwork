import { requirePrivileged, route } from "@/lib/guards";
import { removePaymentFromApp } from "@/lib/pages/invoices";

/** An owner or admin takes a payment entered by mistake back off the invoice. */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ id: string; paymentId: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const { id, paymentId } = await params;
  return Response.json({ invoice: await removePaymentFromApp(caller, id, paymentId) });
});
