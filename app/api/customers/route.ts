import { requirePrivileged, route } from "@/lib/guards";
import { mergeCandidatesFor } from "@/lib/pages/customers";

/** An owner's or admin's customer search, for picking the duplicate to merge (`?q=`, `?exclude=`). */
export const GET = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").slice(0, 200);
  const customers = query.trim() ? await mergeCandidatesFor(caller, query, url.searchParams.get("exclude") ?? undefined) : [];
  return Response.json({ customers });
});
