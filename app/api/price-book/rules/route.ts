import { requirePrivileged, route } from "@/lib/guards";
import { createRuleFromApp, newRuleSchema } from "@/lib/pages/pricebook";

/** An owner or admin adds a rule, active now. */
export const POST = route(async (request: Request) => {
  const caller = await requirePrivileged(request.headers);
  const input = newRuleSchema.parse(await request.json().catch(() => null));
  return Response.json({ rule: await createRuleFromApp(caller, input) }, { status: 201 });
});
