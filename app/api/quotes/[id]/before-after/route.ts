import { requireMember, route } from "@/lib/guards";
import { beforeAfterFile, beforeAfterQuery, fileResponse } from "@/lib/pages/quotes";

/**
 * The quote's before-and-after, for anyone who may see the quote; `outlines=1` outlines the quoted
 * things. Cached for good when `v` is its version, since a new version is a new address (and so is each
 * option); never cached otherwise.
 */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  const query = beforeAfterQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
  const file = await beforeAfterFile(caller, id, { outlines: query.outlines });
  return fileResponse(file, query.v === String(file.version) ? "private, max-age=31536000, immutable" : "no-store");
});
