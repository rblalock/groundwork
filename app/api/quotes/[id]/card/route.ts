import { requireMember, route } from "@/lib/guards";
import { quoteCardFor } from "@/lib/pages/quotes";

/** A quote as its card in the chat shows it, for whoever may see the quote. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  return Response.json({ quote: await quoteCardFor(caller, (await params).id) });
});
