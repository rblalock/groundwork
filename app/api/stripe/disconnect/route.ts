import { memberCaller, requireOwner, route } from "@/lib/guards";
import { disconnectStripe } from "@/lib/stripe";

/** The owner stops taking card payments through the business's Stripe account. */
export const POST = route(async (request: Request) => {
  const caller = memberCaller(await requireOwner(request.headers));
  await disconnectStripe(caller.orgId, caller.memberId);
  return Response.json({ ok: true });
});
