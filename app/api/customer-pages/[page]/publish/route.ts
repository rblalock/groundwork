import { requirePrivileged, route } from "@/lib/guards";
import { pageKindSchema, publishFromApp, publishSchema } from "@/lib/pages/customer-pages";

/** An owner or admin makes a version (the newest by default) the page customers see. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ page: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const page = pageKindSchema.parse((await params).page);
  const { version } = publishSchema.parse(await request.json().catch(() => ({})));
  return Response.json({ state: await publishFromApp(caller, page, version) });
});
