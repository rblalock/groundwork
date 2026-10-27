import { requireMember, route } from "@/lib/guards";
import { reviseQuoteFromApp } from "@/lib/pages/quote-editor";

/** Changes a quote from its page (its lines, its notes for the customer, its photos): a new revision of the one the page showed. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  return Response.json(await reviseQuoteFromApp(caller, id, await request.json().catch(() => null)));
});
