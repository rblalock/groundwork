import { openCheckout } from "@/lib/stripe";

/** The pay page's button: Stripe's checkout for the balance as it is now, or back to the page when it can't be paid. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  try {
    const checkout = await openCheckout(token);
    return Response.redirect(checkout?.url ?? new URL(`/pay/${token}`, request.url), 303);
  } catch (error) {
    console.error("pay: checkout failed", error);
    return Response.redirect(new URL(`/pay/${token}`, request.url), 303);
  }
}
