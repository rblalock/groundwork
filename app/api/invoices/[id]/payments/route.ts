import { requirePrivileged, route } from "@/lib/guards";
import { paymentSchema, recordPaymentFromApp } from "@/lib/pages/invoices";

/** An owner or admin records money received: never more than the balance. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const input = paymentSchema.parse(await request.json().catch(() => null));
  return Response.json({ invoice: await recordPaymentFromApp(caller, (await params).id, input) }, { status: 201 });
});
