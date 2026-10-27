import { requireMember, route } from "@/lib/guards";
import { statusSchema, visitStatusFromApp } from "@/lib/pages/schedule";

/** Marks a visit done (crew, their own), or cancels or confirms it (owners and admins). */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const caller = await requireMember(request.headers);
  const input = statusSchema.parse(await request.json().catch(() => null));
  return Response.json({ visit: await visitStatusFromApp(caller, (await params).id, input) });
});
