import { requireMember, route } from "@/lib/guards";
import { setQuoteLanguageFromApp } from "@/lib/pages/quote-language";

/** Writes the quote in English or Spanish: a new revision of the one the page showed. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  return Response.json(await setQuoteLanguageFromApp(caller, id, await request.json().catch(() => null)));
});
