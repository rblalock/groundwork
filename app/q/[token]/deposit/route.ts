import { openDepositCheckout } from "@/lib/stripe";

/** The quote link's deposit button: Stripe's checkout for what's still due, or back to the page when nothing can be paid. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  try {
    const checkout = await openDepositCheckout(token);
    return Response.redirect(checkout?.url ?? new URL(`/q/${token}`, request.url), 303);
  } catch (error) {
    console.error("quote link: deposit checkout failed", error);
    return Response.redirect(new URL(`/q/${token}`, request.url), 303);
  }
}
