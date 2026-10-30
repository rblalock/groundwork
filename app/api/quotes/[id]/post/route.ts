import { requireMember, route } from "@/lib/guards";
import { fileResponse, socialPostFile, socialPostQuery } from "@/lib/pages/quotes";

/**
 * The quote's social post from its before-and-after, for anyone who may see the quote: `format=square`
 * or `story`, and `cta=1` or `0` for the line asking for the next job. Cached for good when `v` is the
 * before-and-after's version; never cached otherwise.
 */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  const query = socialPostQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  const file = await socialPostFile(caller, id, { format: query.format, cta: query.cta });
  return fileResponse(file, query.v === String(file.version) ? "private, max-age=31536000, immutable" : "no-store");
});
