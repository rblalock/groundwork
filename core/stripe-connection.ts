// Whether a business can take card payments: the app has Stripe set up (its keys, or the fake for dev,
// tests, and evals), and the business has connected its own Stripe account and Stripe lets it charge.
// The Stripe client itself is the web app's (lib/stripe.ts); this is what the agent needs to know.
import { eq } from "drizzle-orm";
import { stripeAccounts } from "../schema/schema";
import { db, type Db, type Tx } from "./db";

export type StripeAccount = typeof stripeAccounts.$inferSelect;

/** `fake` with `STRIPE_FAKE=1`; `live` with the secret key and webhook secret; null when Stripe isn't set up. */
export function stripeMode(): "fake" | "live" | null {
  if (process.env.STRIPE_FAKE === "1") return "fake";
  return process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET ? "live" : null;
}

export async function getStripeAccount(orgId: string, executor: Db | Tx = db()): Promise<StripeAccount | null> {
  const [row] = await executor.select().from(stripeAccounts).where(eq(stripeAccounts.orgId, orgId));
  return row ?? null;
}

/** True when the business's invoices get a pay link. */
export async function takesCardPayments(orgId: string, executor: Db | Tx = db()): Promise<boolean> {
  if (!stripeMode()) return false;
  const account = await getStripeAccount(orgId, executor);
  return account?.status === "active" && account.chargesEnabled;
}
