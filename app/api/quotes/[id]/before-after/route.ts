import { requireMember, route } from "@/lib/guards";
import { beforeAfterFile, fileResponse } from "@/lib/pages/quotes";

/**
 * The quote's before-and-after, for anyone who may see the quote. Cached for good when `v` is its
 * version, since a new version is a new address; never cached otherwise.
 */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const { id } = await params;
  const file = await beforeAfterFile(caller, id);
  const current = new URL(request.url).searchParams.get("v") === String(file.version);
  return fileResponse(file, current ? "private, max-age=31536000, immutable" : "no-store");
});
