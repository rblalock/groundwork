import { handleStripeWebhook } from "@/lib/stripe";

export const runtime = "nodejs";

const MAX_BYTES = 1_000_000;

/**
 * Stripe's Connect webhook: events from the businesses' own accounts. The signature is checked against
 * the raw body before anything is read; a failure inside is a 500, so Stripe delivers the event again.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return Response.json({ error: "Too large." }, { status: 413 });
  try {
    const result = await handleStripeWebhook(raw, request.headers.get("stripe-signature"));
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    console.error("stripe webhook failed", error);
    return Response.json({ error: "Not handled. Try again." }, { status: 500 });
  }
}
