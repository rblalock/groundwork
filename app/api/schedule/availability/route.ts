import { requireMember, route } from "@/lib/guards";
import { availabilityFromApp, availabilitySchema } from "@/lib/pages/schedule";

/** Open times for the crew picked. Crew may look up only themselves. Holds nothing. */
export const POST = route(async (request: Request) => {
  const caller = await requireMember(request.headers);
  const input = availabilitySchema.parse(await request.json().catch(() => null));
  return Response.json({ slots: await availabilityFromApp(caller, input) });
});
