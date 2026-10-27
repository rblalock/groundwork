import { requirePrivileged, route } from "@/lib/guards";
import { invoicePdf } from "@/lib/pages/invoices";
import { fileResponse } from "@/lib/pages/quotes";

/** The invoice's current PDF, for owners and admins. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  return fileResponse(await invoicePdf(caller, (await params).id));
});
