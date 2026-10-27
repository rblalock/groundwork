import { requirePrivileged, route } from "@/lib/guards";
import { pageKindSchema, restoreFromApp, restoreSchema } from "@/lib/pages/customer-pages";

/** An owner or admin brings back an earlier version as the newest draft. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ page: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const page = pageKindSchema.parse((await params).page);
  const { version } = restoreSchema.parse(await request.json().catch(() => null));
  return Response.json(await restoreFromApp(caller, page, version));
});
