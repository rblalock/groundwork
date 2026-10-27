import { completeFakeCheckout, decodeFakeCheckout, deliverFakeEvent, stripeMode, successUrlFor } from "@/lib/stripe";

/**
 * The fake checkout's Pay button (STRIPE_FAKE=1 only): no card is charged. It marks the session paid,
 * delivers the `checkout.session.completed` event Stripe would send, signed, to the webhook, then goes
 * where Stripe would: the success page, with the session's id for it to confirm.
 */
export async function POST(request: Request): Promise<Response> {
  if (stripeMode() !== "fake") return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const checkout = decodeFakeCheckout(String(form.get("c") ?? ""));
  if (!checkout) return new Response("Not found", { status: 404 });
  const origin = new URL(request.url).origin;
  await deliverFakeEvent(origin, { type: "checkout.session.completed", account: checkout.accountId, object: completeFakeCheckout(checkout, String(form.get("email") ?? "")) });
  return Response.redirect(new URL(successUrlFor(checkout), origin), 303);
}
