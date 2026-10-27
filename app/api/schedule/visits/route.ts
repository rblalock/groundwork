import { requirePrivileged, route } from "@/lib/guards";
import { bookFromApp, bookSchema } from "@/lib/pages/schedule";

/** An owner or admin books a visit, through the same rules as book_visit. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const input = bookSchema.parse(await request.json().catch(() => null));
  return Response.json({ visit: await bookFromApp(caller, input) });
});
