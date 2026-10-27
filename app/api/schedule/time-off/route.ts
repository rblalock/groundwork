import { requireMember, route } from "@/lib/guards";
import { addTimeOffFromApp, timeOffSchema } from "@/lib/pages/schedule";

/** Time off: crew their own, owners and admins anyone's or the whole business's. */
export const POST = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const input = timeOffSchema.parse(await request.json().catch(() => null));
  return Response.json(await addTimeOffFromApp(caller, input));
});
