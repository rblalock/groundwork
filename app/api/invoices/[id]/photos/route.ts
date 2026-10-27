import { requirePrivileged, route } from "@/lib/guards";
import { photosSchema, setPhotosFromApp } from "@/lib/pages/invoices";

/** An owner or admin chooses which photos of the work print on the invoice's PDF. */
export const PUT = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const input = photosSchema.parse(await request.json().catch(() => null));
  return Response.json({ invoice: await setPhotosFromApp(caller, (await params).id, input) });
});
