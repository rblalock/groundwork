import { requirePrivileged, route } from "@/lib/guards";
import { createFromApp, createSchema } from "@/lib/pages/invoices";

/** An owner or admin invoices finished work or an agreed quote (asking again returns the same invoice), or starts one from scratch. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const input = createSchema.parse(await request.json().catch(() => null));
  const { invoice, created } = await createFromApp(caller, input);
  return Response.json({ invoiceId: invoice.id, created }, { status: created ? 201 : 200 });
});
