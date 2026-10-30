import { requireMember, route } from "@/lib/guards";
import { quoteCardFor, quoteCardQuery } from "@/lib/pages/quotes";

/** A quote as its card in the chat shows it, for whoever may see the quote; `post=square` or `story` shows its post. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const query = quoteCardQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json({ quote: await quoteCardFor(caller, (await params).id, { post: query.post }) });
});
