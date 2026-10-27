import { requireMember, route } from "@/lib/guards";
import { ownProfileSchema, updateOwnProfileFromApp } from "@/lib/pages/team";

/** The signed-in member changes their own name or the language they read the app in. */
export const PATCH = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const update = ownProfileSchema.parse(await request.json().catch(() => null));
  return Response.json({ member: await updateOwnProfileFromApp(caller, update) });
});
