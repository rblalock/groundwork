import { requireOwner, route } from "@/lib/guards";
import { refreshStripeAccount } from "@/lib/stripe";

/** Where Stripe sends the owner back after onboarding: read the account's state, then back to Settings. */
export const GET = route(async (request: Request) => {
  const caller = await requireOwner(request.headers);
  const status = await refreshStripeAccount(caller.orgId);
  return Response.redirect(new URL(`/settings/payments?stripe=${status}`, request.url), 303);
});
