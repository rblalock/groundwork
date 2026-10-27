import { requirePrivileged, route } from "@/lib/guards";
import { pageKindSchema, standardFromApp } from "@/lib/pages/customer-pages";

/** An owner or admin goes back to the app's standard page. The designs stay. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ page: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  return Response.json({ state: await standardFromApp(caller, pageKindSchema.parse((await params).page)) });
});
