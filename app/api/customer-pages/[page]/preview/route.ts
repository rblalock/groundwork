import { requirePrivileged, route } from "@/lib/guards";
import { pageKindSchema, previewFor, previewSchema } from "@/lib/pages/customer-pages";

/** A version of the page (the newest by default) filled with a sample or the newest real document, for the editor's preview. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ page: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const page = pageKindSchema.parse((await params).page);
  const input = previewSchema.parse(await request.json().catch(() => null));
  return Response.json({ html: await previewFor(caller, page, input) }, { headers: { "cache-control": "private, no-store" } });
});
