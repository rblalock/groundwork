import { requirePrivileged, route } from "@/lib/guards";
import { addMemberFromApp, addMemberSchema } from "@/lib/pages/team";

/** An owner or admin adds someone; the answer carries the invite to forward. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const input = addMemberSchema.parse(await request.json().catch(() => null));
  return Response.json(await addMemberFromApp(caller, input), { status: 201 });
});
