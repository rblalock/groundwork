import { HttpError, memberCaller, requireOwner, route } from "@/lib/guards";
import { startStripeConnect, stripeMode } from "@/lib/stripe";

async function start(request: Request): Promise<{ url: string }> {
  const caller = memberCaller(await requireOwner(request.headers));
  if (!stripeMode()) throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Card payments aren't set up for this app yet.");
  return startStripeConnect(caller.orgId, caller.memberId);
}

/** The owner starts (or continues) connecting the business's Stripe account: the Stripe page to go to. */
export const POST = route(async (request: Request) => Response.json(await start(request)));

/** Stripe sends the owner here when an onboarding link has expired: a fresh one. */
export const GET = route(async (request: Request) => Response.redirect((await start(request)).url, 303));
