import { completeFakeOnboarding, deliverFakeEvent, stripeMode } from "@/lib/stripe";

/**
 * The fake Stripe's onboarding page (STRIPE_FAKE=1 only): the owner "finishes" Stripe's forms at once.
 * Stripe would then send `account.updated`; the fake delivers it, signed, to the webhook.
 */
export async function GET(request: Request): Promise<Response> {
  if (stripeMode() !== "fake") return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const account = url.searchParams.get("account") ?? "";
  if (!/^acct_fake_[0-9a-f]+$/.test(account)) return new Response("Not found", { status: 404 });
  const state = completeFakeOnboarding(account);
  await deliverFakeEvent(url.origin, {
    type: "account.updated",
    account,
    object: { id: account, object: "account", charges_enabled: state.chargesEnabled, details_submitted: state.detailsSubmitted, payouts_enabled: true },
  });
  const back = url.searchParams.get("return");
  const target = back && new URL(back, url.origin).origin === url.origin ? back : "/settings/payments";
  return Response.redirect(new URL(target, url.origin), 303);
}
