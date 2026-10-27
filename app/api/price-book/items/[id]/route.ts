import { requirePrivileged, route } from "@/lib/guards";
import { itemPatchSchema, updateItemFromApp } from "@/lib/pages/pricebook";

/** An owner or admin edits, retires, or restores an item. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requirePrivileged(request.headers);
  const patch = itemPatchSchema.parse(await request.json().catch(() => null));
  const item = await updateItemFromApp(caller, (await params).id, patch);
  return Response.json({ item });
});
