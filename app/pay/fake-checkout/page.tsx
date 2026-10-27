import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { money } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { decodeFakeCheckout, stripeMode } from "@/lib/stripe";

export const dynamic = "force-dynamic";

/**
 * The fake Stripe's checkout (STRIPE_FAKE=1 only), standing in for Stripe's hosted page in dev, tests,
 * and evals. Paying delivers the webhook Stripe would send; no card is involved. Like Stripe's, it asks
 * for an email for the receipt when the customer has none on file.
 */
export default async function FakeCheckoutPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  if (stripeMode() !== "fake") notFound();
  const { c = "" } = await searchParams;
  const checkout = decodeFakeCheckout(c);
  const p = pageCopyFor("en").pay;
  if (!checkout) return <p className="text-center text-[14px] text-ink-2">{p.invalid}</p>;
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-accent-ink">
          <FlaskConical aria-hidden="true" className="size-3.5" />
          {p.fakeTitle}
        </p>
        <h1 className="text-[15px] font-semibold text-ink text-pretty">{checkout.description}</h1>
        <p className="text-[12px] text-ink-3 text-pretty">{p.fakeBody}</p>
      </header>
      <p className="text-2xl font-semibold text-ink tabular-nums">{money(checkout.amountCents, "en")}</p>
      <form action="/api/stripe/fake/complete" method="post">
        <input name="c" type="hidden" value={c} />
        {checkout.customerEmail ? null : (
          // Stripe's checkout asks for an email when none was on file; the receipt goes there.
          <label className="mb-3 block space-y-1 text-[12px] text-ink-2">
            <span>{p.fakeEmail}</span>
            <input
              autoComplete="email"
              className="block w-full rounded-md border border-line bg-surface px-3 py-2 text-[14px] text-ink"
              name="email"
              placeholder="customer@example.test"
              type="email"
            />
          </label>
        )}
        <button
          className="inline-flex w-full items-center justify-center rounded-full bg-ink px-4 py-[11px] text-sm font-medium text-canvas transition-opacity hover:opacity-90"
          type="submit"
        >
          {p.fakePay(money(checkout.amountCents, "en"))}
        </button>
      </form>
      <a className="block text-center text-[13px] text-ink-2 hover:underline" href={checkout.cancelUrl}>
        {p.fakeCancel}
      </a>
    </div>
  );
}
