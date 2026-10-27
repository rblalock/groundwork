import { requirePrivileged, route } from "@/lib/guards";
import { createItemFromApp, newItemSchema } from "@/lib/pages/pricebook";

/** An owner or admin adds an item to the price book. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const input = newItemSchema.parse(await request.json().catch(() => null));
  return Response.json({ item: await createItemFromApp(caller, input) }, { status: 201 });
});
