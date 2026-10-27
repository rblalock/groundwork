// Card payments through Stripe Connect. Each business connects its own Stripe account (a Standard
// account, made through Account Links): the business is the merchant, its customers' card payments go
// straight to it as direct charges, it refunds and handles disputes in its own Stripe dashboard, and the
// app takes no fee. An invoice's pay link (/pay/<token>) opens a Checkout Session on that account for
// the balance; Stripe's webhook (/api/webhooks/stripe, a Connect endpoint) records the payment, and so
// does the customer's return to /pay/<token>/done, which asks Stripe about its session rather than wait.
// Either way the payment is recorded once, with the card it was made with, and the customer gets a receipt:
// on the page, as a PDF, and by email from Stripe on the business's account (its `receipt_email`).
//
// Behind STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. STRIPE_FAKE=1 (dev, tests, evals) swaps the
// network calls for a fake that makes accounts and checkout pages locally and delivers webhook events
// signed like Stripe's, so the same signature check, dedupe, and recording run end to end.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { quotes, stripeAccounts, stripeEvents } from "../schema/schema";
import { appOrigin } from "../core/app-url";
import { logoVersionFor, pageBusiness, type PageBusiness } from "../core/branding";
import { getCustomer } from "../core/customers";
import { db } from "../core/db";
import { recordEvent } from "../core/events";
import {
  cardText,
  getInvoice,
  invoiceForQuote,
  quoteDeposits,
  recordStripeDeposit,
  invoiceByPayToken,
  invoiceLabel,
  recordStripeRefund,
  stripeRefundText,
  noteCheckoutSession,
  receiptPayments,
  recordStripePayment,
  renderReceipt,
  stripePaidText,
  stripePaymentRecorded,
  type CardDetails,
  type Invoice,
  type PaymentMethod,
} from "../core/invoices";
import { isLanguage } from "../core/language";
import type { Member } from "../core/members";
import { notifyOwners } from "../core/outbound";
import { getProfile } from "../core/profile";
import { depositPaidText, quoteByCustomerToken, type Quote } from "../core/quote-link";
import { getStripeAccount, stripeMode, type StripeAccount } from "../core/stripe-connection";

export { stripeMode };

export type AccountState = { chargesEnabled: boolean; detailsSubmitted: boolean; disabledReason: string | null };
/** A payment's charge on a connected account: its card, and where Stripe emails its receipt (null: nowhere yet). */
export type ChargeDetails = { chargeId: string; card: CardDetails | null; receiptEmail: string | null };
/** A checkout for an invoice's balance (`invoiceId`) or a quote's deposit (`quoteId`): exactly one of them. */
export type CheckoutRequest = {
  accountId: string;
  orgId: string;
  invoiceId?: string;
  quoteId?: string;
  amountCents: number;
  description: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
};

/** What the app asks of Stripe. The live one calls the API; the fake one stays on this machine. */
export interface StripeGateway {
  createAccount(input: { orgId: string; businessName: string; email: string | null }): Promise<{ accountId: string }>;
  accountLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<string>;
  /** Null when the fake doesn't know the account (its state lives in this process). */
  retrieveAccount(accountId: string): Promise<AccountState | null>;
  createCheckoutSession(input: CheckoutRequest): Promise<{ id: string; url: string }>;
  /**
   * A Checkout Session on a connected account, in Stripe's own shape (the object a webhook carries). Null
   * when that account has no such session: Stripe looks only within the account it's asked on, so an id
   * from another account, or a made-up one, is simply not found.
   */
  retrieveCheckoutSession(input: { accountId: string; sessionId: string }): Promise<Record<string, unknown> | null>;
  /** A PaymentIntent's latest charge on a connected account: the card it was paid with, and its receipt email. Null before it's charged. */
  retrieveCharge(input: { accountId: string; paymentIntentId: string }): Promise<ChargeDetails | null>;
  /** Sets a charge's receipt email, on its connected account: Stripe emails the customer a receipt when it changes. */
  setReceiptEmail(input: { accountId: string; chargeId: string; email: string }): Promise<void>;
}

const FAKE_WEBHOOK_SECRET = "whsec_fake_local_only";

/** The webhook signing secret: Stripe's for the Connect endpoint, or the fake's. */
export function webhookSecret(): string | null {
  if (stripeMode() === "fake") return process.env.STRIPE_WEBHOOK_SECRET || FAKE_WEBHOOK_SECRET;
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

function client(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_NOT_CONFIGURED");
  // The SDK pins the API version its types describe.
  return new Stripe(key, { timeout: 15_000, maxNetworkRetries: 1, appInfo: { name: "groundwork" } });
}

const liveGateway = (): StripeGateway => ({
  async createAccount({ orgId, businessName, email }) {
    // Standard: the business's own full Stripe dashboard; it pays Stripe's fees and carries its own losses.
    // Made through Accounts v2, which Stripe requires for new Connect platforms; the v1 calls below
    // (account links, retrieve, checkout, account.updated) work on it as a Standard account.
    const account = await client().v2.core.accounts.create({
      display_name: businessName,
      ...(email ? { contact_email: email } : {}),
      dashboard: "full",
      identity: { country: "us" },
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      metadata: { orgId },
    });
    return { accountId: account.id };
  },
  async accountLink({ accountId, refreshUrl, returnUrl }) {
    const link = await client().accountLinks.create({ account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: "account_onboarding" });
    return link.url;
  },
  async retrieveAccount(accountId) {
    const account = await client().accounts.retrieve(accountId);
    return {
      chargesEnabled: account.charges_enabled ?? false,
      detailsSubmitted: account.details_submitted ?? false,
      disabledReason: account.requirements?.disabled_reason ?? null,
    };
  },
  async createCheckoutSession(input) {
    const session = await client().checkout.sessions.create(checkoutSessionParams(input), { stripeAccount: input.accountId });
    if (!session.url) throw new Error("STRIPE_NO_CHECKOUT_URL");
    return { id: session.id, url: session.url };
  },
  async retrieveCheckoutSession({ accountId, sessionId }) {
    try {
      const session = await client().checkout.sessions.retrieve(sessionId, {}, { stripeAccount: accountId });
      return session as unknown as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && (error.code === "resource_missing" || error.statusCode === 404)) return null;
      throw error;
    }
  },
  async retrieveCharge({ accountId, paymentIntentId }) {
    const intent = await client().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] }, { stripeAccount: accountId });
    const charge = intent.latest_charge;
    if (!charge || typeof charge === "string") return null;
    const card = charge.payment_method_details?.card;
    return { chargeId: charge.id, card: card ? { brand: card.brand ?? null, last4: card.last4 ?? null } : null, receiptEmail: charge.receipt_email ?? null };
  },
  async setReceiptEmail({ accountId, chargeId, email }) {
    await client().charges.update(chargeId, { receipt_email: email }, { stripeAccount: accountId });
  },
});

/**
 * What a pay link's Checkout Session is made with. The customer's email on file, when there is one, is
 * both checkout's and the payment's `receipt_email`: Stripe emails a receipt for a live payment that has
 * one, whatever the account's own email settings.
 */
export function checkoutSessionParams(input: CheckoutRequest): Stripe.Checkout.SessionCreateParams {
  const metadata = sessionMetadata(input);
  return {
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: input.amountCents, product_data: { name: input.description } } }],
    client_reference_id: input.invoiceId ?? input.quoteId,
    metadata,
    payment_intent_data: { metadata, description: input.description, ...(input.customerEmail ? { receipt_email: input.customerEmail } : {}) },
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
}

/** What a session carries back to the webhook: its business, and the invoice or quote it pays. */
function sessionMetadata(input: Pick<CheckoutRequest, "orgId" | "invoiceId" | "quoteId">): Record<string, string> {
  if (input.invoiceId) return { orgId: input.orgId, invoiceId: input.invoiceId };
  if (input.quoteId) return { orgId: input.orgId, quoteId: input.quoteId, kind: "deposit" };
  throw new Error("CHECKOUT_FOR_NOTHING");
}

// ---------------------------------------------------------------------------------------------
// The fake

/** A checkout the fake made, carried in its page's URL and signed, so any process can complete it. */
export type FakeCheckout = CheckoutRequest & { sessionId: string };

/** A receipt email the fake was asked for: at checkout (the payment's `receipt_email`), or later on its charge. */
export type FakeReceiptEmail = { via: "checkout" | "charge"; id: string; email: string };

type FakeSession = { checkout: FakeCheckout; paid: boolean; collectedEmail: string | null; receiptEmail: string | null };
type FakeState = { accounts: Map<string, AccountState>; sessions: Map<string, FakeSession>; receiptEmails: FakeReceiptEmail[] };
const fakeState = (): FakeState => {
  const g = globalThis as { __fakeStripe?: Partial<FakeState> };
  g.__fakeStripe ??= {};
  g.__fakeStripe.accounts ??= new Map();
  g.__fakeStripe.sessions ??= new Map();
  g.__fakeStripe.receiptEmails ??= [];
  return g.__fakeStripe as FakeState;
};

/** The receipt emails the fake was asked to send, oldest first. It sends none; tests read this instead. */
export function fakeReceiptEmails(): FakeReceiptEmail[] {
  return [...fakeState().receiptEmails];
}

/** A fake checkout as Stripe would show its session: open until it's paid, then complete and paid. */
function fakeSessionObject(checkout: FakeCheckout, paid: boolean, collectedEmail: string | null = null): Record<string, unknown> {
  const email = checkout.customerEmail ?? collectedEmail;
  return {
    id: checkout.sessionId,
    object: "checkout.session",
    amount_total: checkout.amountCents,
    currency: "usd",
    payment_status: paid ? "paid" : "unpaid",
    status: paid ? "complete" : "open",
    payment_intent: paid ? checkout.sessionId.replace(/^cs_/, "pi_") : null,
    client_reference_id: checkout.invoiceId ?? checkout.quoteId,
    customer_details: email ? { email } : null,
    metadata: sessionMetadata(checkout),
  };
}

/**
 * Pays a fake checkout, as the customer paying on Stripe's page would (`/api/stripe/fake/complete`): from
 * then on the fake reports its session paid. `email` is the one checkout collected when none was on file.
 * Returns the session, for the webhook event Stripe would send.
 */
export function completeFakeCheckout(checkout: FakeCheckout, email?: string | null): Record<string, unknown> {
  const collectedEmail = email?.trim() || null;
  const known = fakeState().sessions.get(checkout.sessionId);
  fakeState().sessions.set(checkout.sessionId, {
    checkout,
    paid: true,
    collectedEmail,
    receiptEmail: known?.receiptEmail ?? checkout.customerEmail,
  });
  return fakeSessionObject(checkout, true, collectedEmail);
}

/** Where Stripe sends the customer after paying: the success URL, with the session's id in place of Stripe's template. */
export function successUrlFor(checkout: Pick<FakeCheckout, "successUrl" | "sessionId">): string {
  return checkout.successUrl.replaceAll("{CHECKOUT_SESSION_ID}", checkout.sessionId);
}

const sign = (payload: string) => createHmac("sha256", webhookSecret() ?? FAKE_WEBHOOK_SECRET).update(payload).digest("base64url");

export function encodeFakeCheckout(checkout: FakeCheckout): string {
  const payload = Buffer.from(JSON.stringify(checkout)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeFakeCheckout(token: string): FakeCheckout | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as FakeCheckout;
  } catch {
    return null;
  }
}

const fakeId = (prefix: string) => `${prefix}_fake_${randomBytes(8).toString("hex")}`;

const fakeGateway = (): StripeGateway => ({
  async createAccount() {
    const accountId = fakeId("acct");
    fakeState().accounts.set(accountId, { chargesEnabled: false, detailsSubmitted: false, disabledReason: "requirements.past_due" });
    return { accountId };
  },
  async accountLink({ accountId, returnUrl }) {
    const query = new URLSearchParams({ account: accountId, return: returnUrl });
    return `${appOrigin()}/api/stripe/fake/onboard?${query}`;
  },
  async retrieveAccount(accountId) {
    return fakeState().accounts.get(accountId) ?? null;
  },
  async createCheckoutSession(input) {
    const sessionId = fakeId("cs");
    const checkout = { ...input, sessionId };
    fakeState().sessions.set(sessionId, { checkout, paid: false, collectedEmail: null, receiptEmail: input.customerEmail });
    if (input.customerEmail) fakeState().receiptEmails.push({ via: "checkout", id: sessionId, email: input.customerEmail });
    return { id: sessionId, url: `${appOrigin()}/pay/fake-checkout?c=${encodeURIComponent(encodeFakeCheckout(checkout))}` };
  },
  async retrieveCheckoutSession({ accountId, sessionId }) {
    const session = fakeState().sessions.get(sessionId);
    // Like Stripe, a session is found only on the account it was made on.
    if (!session || session.checkout.accountId !== accountId) return null;
    return fakeSessionObject(session.checkout, session.paid, session.collectedEmail);
  },
  async retrieveCharge({ paymentIntentId }) {
    // The fake's PaymentIntent and charge share their session's id; one it never made is a plain test card.
    const suffix = paymentIntentId.replace(/^pi_/, "");
    const session = fakeState().sessions.get(`cs_${suffix}`);
    return { chargeId: `ch_${suffix}`, card: { brand: "visa", last4: "4242" }, receiptEmail: session?.receiptEmail ?? null };
  },
  async setReceiptEmail({ chargeId, email }) {
    const session = fakeState().sessions.get(chargeId.replace(/^ch_/, "cs_"));
    if (session) session.receiptEmail = email;
    fakeState().receiptEmails.push({ via: "charge", id: chargeId, email });
  },
});

let gatewayForTests: StripeGateway | null = null;
/** Tests swap in their own gateway; null restores the default. */
export function setStripeGatewayForTests(gateway: StripeGateway | null): void {
  gatewayForTests = gateway;
}

export function stripeGateway(): StripeGateway {
  if (gatewayForTests) return gatewayForTests;
  const mode = stripeMode();
  if (mode === "fake") return fakeGateway();
  if (mode === "live") return liveGateway();
  throw new Error("STRIPE_NOT_CONFIGURED");
}

/** Marks a fake account as onboarded, as Stripe would after the owner finishes its forms. */
export function completeFakeOnboarding(accountId: string): AccountState {
  const state = { chargesEnabled: true, detailsSubmitted: true, disabledReason: null };
  fakeState().accounts.set(accountId, state);
  return state;
}

/** A webhook body and its `stripe-signature` header, signed with the webhook secret: what the fake delivers. */
export function signedEvent(event: { id?: string; type: string; account: string; object: Record<string, unknown> }): { body: string; signature: string } {
  const body = JSON.stringify({
    id: event.id ?? fakeId("evt"),
    object: "event",
    type: event.type,
    account: event.account,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: Stripe.API_VERSION,
    data: { object: event.object },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret() ?? FAKE_WEBHOOK_SECRET });
  return { body, signature };
}

// ---------------------------------------------------------------------------------------------
// Connecting a business

export type StripeSettings = {
  /** Whether the app has Stripe set up at all (keys, or the fake). */
  available: boolean;
  fake: boolean;
  status: StripeAccount["status"] | "not_connected";
  accountId: string | null;
};

export async function stripeSettings(orgId: string): Promise<StripeSettings> {
  const mode = stripeMode();
  const account = await getStripeAccount(orgId);
  return { available: mode !== null, fake: mode === "fake", status: account?.status ?? "not_connected", accountId: account?.accountId ?? null };
}

function statusFrom(state: AccountState): StripeAccount["status"] {
  if (state.chargesEnabled) return "active";
  return state.detailsSubmitted ? "restricted" : "onboarding";
}

async function saveAccountState(orgId: string, state: AccountState): Promise<StripeAccount["status"]> {
  const status = statusFrom(state);
  await db()
    .update(stripeAccounts)
    .set({ status, chargesEnabled: state.chargesEnabled, detailsSubmitted: state.detailsSubmitted, updatedAt: new Date() })
    .where(eq(stripeAccounts.orgId, orgId));
  return status;
}

/**
 * Starts or continues connecting the business's Stripe account: makes its account on first use (or
 * brings back the one it disconnected), and returns the Stripe page where the owner fills in its
 * details. Stripe sends them back to /api/stripe/return.
 */
export async function startStripeConnect(orgId: string, memberId: string): Promise<{ url: string }> {
  const gateway = stripeGateway();
  let account = await getStripeAccount(orgId);
  if (!account) {
    const profile = await getProfile(orgId);
    const { accountId } = await gateway.createAccount({ orgId, businessName: profile.name, email: profile.email });
    [account] = await db()
      .insert(stripeAccounts)
      .values({ orgId, accountId, status: "onboarding", connectedByMemberId: memberId })
      .onConflictDoUpdate({ target: stripeAccounts.orgId, set: { accountId, status: "onboarding", connectedByMemberId: memberId, updatedAt: new Date() } })
      .returning();
    await recordEvent({ orgId, kind: "stripe.account_created", memberId, data: { accountId } });
  } else if (account.status === "disconnected") {
    await db()
      .update(stripeAccounts)
      .set({ status: "onboarding", connectedByMemberId: memberId, updatedAt: new Date() })
      .where(eq(stripeAccounts.orgId, orgId));
  }
  const origin = appOrigin();
  const url = await gateway.accountLink({
    accountId: account.accountId,
    refreshUrl: `${origin}/api/stripe/connect?again=1`,
    returnUrl: `${origin}/api/stripe/return`,
  });
  return { url };
}

/** Reads the account's state back from Stripe after onboarding. */
export async function refreshStripeAccount(orgId: string): Promise<StripeAccount["status"] | "not_connected"> {
  const account = await getStripeAccount(orgId);
  if (!account) return "not_connected";
  if (account.status === "disconnected") return "disconnected";
  const state = await stripeGateway().retrieveAccount(account.accountId);
  return state ? saveAccountState(orgId, state) : account.status;
}

/**
 * Stops using the business's Stripe account: pay links stop opening checkout. A Standard account is the
 * business's own, so it stays theirs in Stripe; connecting again picks it back up.
 */
export async function disconnectStripe(orgId: string, memberId: string): Promise<void> {
  await db()
    .update(stripeAccounts)
    .set({ status: "disconnected", chargesEnabled: false, updatedAt: new Date() })
    .where(eq(stripeAccounts.orgId, orgId));
  await recordEvent({ orgId, kind: "stripe.disconnected", memberId });
}

// ---------------------------------------------------------------------------------------------
// The pay link

/** A payment on the customer's receipt. `card` is how its card prints ("Visa •••• 4242"), when Stripe said. */
export type ReceiptLine = { id: string; receivedDate: string; method: PaymentMethod; card: string | null; amountCents: number };

export type PayPage =
  | { kind: "not_found" }
  | {
      kind: "payable" | "paid" | "void" | "unavailable";
      /** The business, for its own design of this page (lib/customer-pages.ts). Never shown. */
      orgId: string;
      /** `logoVersion` is null when the business has no logo; else the page shows it from `/pay/<token>/logo`. */
      business: PageBusiness;
      invoice: {
        label: string;
        title: string;
        balanceCents: number;
        totalCents: number;
        paidCents: number;
        issueDate: string | null;
        dueDate: string | null;
        language: "en" | "es";
      };
      /** The payments still on the invoice, oldest first: the receipt, when anything has been paid. */
      payments: ReceiptLine[];
    };

/** What a customer opening the pay link sees. Drafts aren't the customer's yet, so they look missing. */
export async function payPage(token: string): Promise<PayPage> {
  const invoice = await invoiceByPayToken(token);
  if (!invoice || invoice.status === "draft") return { kind: "not_found" };
  const profile = await getProfile(invoice.orgId);
  const account = await getStripeAccount(invoice.orgId);
  const balanceCents = Math.max(0, invoice.totalCents - invoice.amountPaidCents);
  const kind =
    invoice.status === "void"
      ? "void"
      : balanceCents === 0
        ? "paid"
        : stripeMode() && account?.status === "active" && account.chargesEnabled
          ? "payable"
          : "unavailable";
  return {
    kind,
    orgId: invoice.orgId,
    business: pageBusiness(profile, await logoVersionFor(invoice.orgId)),
    invoice: {
      label: invoiceLabel(invoice.number),
      title: invoice.title,
      balanceCents,
      totalCents: invoice.totalCents,
      paidCents: invoice.amountPaidCents,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      language: isLanguage(invoice.language) ? invoice.language : "en",
    },
    payments: (await receiptPayments(invoice.orgId, invoice.id)).map((p) => ({
      id: p.id,
      receivedDate: p.receivedDate,
      method: p.method,
      card: cardText(p),
      amountCents: p.amountCents,
    })),
  };
}

/**
 * The receipt PDF behind a pay link (`/pay/<token>/receipt`). The token is the customer's key, as for
 * the pay page. Null for an unknown token, a draft, and an invoice nothing has been paid on.
 */
export async function payReceipt(token: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const invoice = await invoiceByPayToken(token);
  if (!invoice || invoice.status === "draft") return null;
  return renderReceipt(invoice.orgId, invoice.id);
}

/**
 * Opens checkout for the invoice's balance on the business's Stripe account. Each opening charges the
 * balance as it is then, so a payment recorded meanwhile is never charged twice. Null when it can't be paid.
 */
export async function openCheckout(token: string): Promise<{ url: string } | null> {
  const invoice: Invoice | null = await invoiceByPayToken(token);
  if (!invoice || !["sent", "partially_paid"].includes(invoice.status)) return null;
  const balance = invoice.totalCents - invoice.amountPaidCents;
  const account = await getStripeAccount(invoice.orgId);
  if (balance <= 0 || !stripeMode() || account?.status !== "active" || !account.chargesEnabled) return null;
  const profile = await getProfile(invoice.orgId);
  const customer = invoice.customerId ? await getCustomer(invoice.orgId, invoice.customerId) : null;
  const origin = appOrigin();
  const label = invoiceLabel(invoice.number);
  const session = await stripeGateway().createCheckoutSession({
    accountId: account.accountId,
    orgId: invoice.orgId,
    invoiceId: invoice.id,
    amountCents: balance,
    description: `${profile.name} · ${label} · ${invoice.title}`.slice(0, 250),
    customerEmail: customer?.emails[0] ?? null,
    // Stripe puts the session's id in place of its template, for the done page to confirm.
    successUrl: `${origin}/pay/${token}/done?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/pay/${token}`,
  });
  await noteCheckoutSession(invoice.orgId, invoice.id, session.id);
  return { url: session.url };
}

/**
 * What's still due of a quote's deposit: what it asked less what's been paid on its link. 0 when it asks
 * none, and once the quote has an invoice: from then on the invoice's pay link takes the money.
 */
export async function depositDue(quote: Pick<Quote, "orgId" | "id" | "status" | "depositCents">): Promise<{ paidCents: number; dueCents: number }> {
  const paidCents = (await quoteDeposits(quote.orgId, quote.id)).reduce((sum, p) => sum + p.amountCents, 0);
  if (quote.status !== "won" || !quote.depositCents || (await invoiceForQuote(quote.orgId, quote.id))) return { paidCents, dueCents: 0 };
  return { paidCents, dueCents: Math.max(0, quote.depositCents - paidCents) };
}

/**
 * Opens checkout for what's still due of a quote's deposit, on the business's Stripe account, from its
 * customer link. Null when nothing's due or the business can't take cards.
 */
export async function openDepositCheckout(token: string): Promise<{ url: string } | null> {
  const quote = await quoteByCustomerToken(token);
  if (!quote) return null;
  const { dueCents } = await depositDue(quote);
  const account = await getStripeAccount(quote.orgId);
  if (dueCents <= 0 || !stripeMode() || account?.status !== "active" || !account.chargesEnabled) return null;
  const profile = await getProfile(quote.orgId);
  const customer = quote.customerId ? await getCustomer(quote.orgId, quote.customerId) : null;
  const origin = appOrigin();
  const language = customer && isLanguage(customer.language) ? customer.language : "en";
  const session = await stripeGateway().createCheckoutSession({
    accountId: account.accountId,
    orgId: quote.orgId,
    quoteId: quote.id,
    amountCents: dueCents,
    description: `${profile.name} · ${language === "es" ? "Depósito" : "Deposit"} · ${quote.title}`.slice(0, 250),
    customerEmail: customer?.emails[0] ?? null,
    successUrl: `${origin}/q/${token}/done?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/q/${token}`,
  });
  await db().update(quotes).set({ stripeCheckoutSessionId: session.id }).where(and(eq(quotes.orgId, quote.orgId), eq(quotes.id, quote.id)));
  return { url: session.url };
}

// ---------------------------------------------------------------------------------------------
// Webhooks

type EventLike = { id: string; type: string; account?: string | null; data: { object: Record<string, unknown> } };
export type WebhookResult = { status: number; body: Record<string, unknown> };

/** Verifies the signature, then handles the event. A bad signature is a 400, and nothing is touched. */
export async function handleStripeWebhook(raw: string, signature: string | null, deps?: { now?: Date }): Promise<WebhookResult> {
  const secret = webhookSecret();
  if (!secret) return { status: 503, body: { error: "Stripe isn't set up." } };
  if (!signature) return { status: 400, body: { error: "Missing signature." } };
  let event: EventLike;
  try {
    event = Stripe.webhooks.constructEvent(raw, signature, secret) as unknown as EventLike;
  } catch {
    return { status: 400, body: { error: "Bad signature." } };
  }
  return { status: 200, body: await processStripeEvent(event, deps) };
}

const str = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * Handles one verified event, once. It finds its business by the connected account it came from (the
 * one lookup here without an org, like a phone for a text); an event from no business's account is
 * acknowledged and dropped. A payment's invoice must be that business's.
 */
export async function processStripeEvent(event: EventLike, deps?: { now?: Date }): Promise<Record<string, unknown>> {
  const accountId = event.account ?? null;
  if (!accountId) return { received: true, ignored: "platform event" };
  const [account] = await db().select().from(stripeAccounts).where(eq(stripeAccounts.accountId, accountId));
  if (!account) return { received: true, ignored: "unknown account" };
  const orgId = account.orgId;
  const [seen] = await db().select().from(stripeEvents).where(eq(stripeEvents.eventId, event.id));
  if (seen) return { received: true, duplicate: true };

  const object = event.data.object;
  let outcome = "ignored";
  if (event.type === "account.updated") {
    outcome = `account:${await saveAccountState(orgId, {
      chargesEnabled: object.charges_enabled === true,
      detailsSubmitted: object.details_submitted === true,
      disabledReason: str((object.requirements as Record<string, unknown> | undefined)?.disabled_reason),
    })}`;
  } else if (event.type === "account.application.deauthorized") {
    await db().update(stripeAccounts).set({ status: "disconnected", chargesEnabled: false, updatedAt: new Date() }).where(eq(stripeAccounts.orgId, orgId));
    outcome = "account:disconnected";
  } else if (
    (event.type === "checkout.session.completed" && object.payment_status === "paid") ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    outcome = await paymentFromSession(orgId, accountId, object, deps);
  } else if (event.type === "checkout.session.completed") {
    outcome = "awaiting_payment";
  } else if (event.type === "charge.refunded") {
    outcome = await refundFromCharge(orgId, object, deps);
  }

  await db().insert(stripeEvents).values({ eventId: event.id, orgId, type: event.type, outcome }).onConflictDoNothing({ target: stripeEvents.eventId });
  return { received: true, outcome };
}

/**
 * Records the payment a paid Checkout Session made, with its card, and texts the owners about it. The
 * one path for both Stripe's webhook and the customer's return to the done page (`confirmCheckout`):
 * whichever comes first records it, and the other finds it there (`duplicate_payment`) and texts nobody,
 * however close together they land (`recordStripePayment`). `session` is in Stripe's shape.
 */
async function paymentFromSession(orgId: string, accountId: string, session: Record<string, unknown>, deps?: { now?: Date }): Promise<string> {
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  if (!str(metadata.invoiceId) && str(metadata.quoteId)) return depositFromSession(orgId, accountId, session, deps);
  const invoiceId = str(metadata.invoiceId);
  const sessionId = str(session.id);
  const amount = typeof session.amount_total === "number" ? session.amount_total : null;
  if (!invoiceId || !sessionId || amount === null || amount <= 0) return "ignored:incomplete";
  // The session's own business must be the account's: metadata from another business's invoice is refused.
  if (str(metadata.orgId) !== orgId) {
    console.error("stripe: a session's business doesn't match its account", { orgId, sessionId });
    return "ignored:org_mismatch";
  }
  if (str(session.currency)?.toLowerCase() !== "usd") return "ignored:currency";
  const found = await getInvoice(orgId, invoiceId);
  if (!found) return "ignored:no_invoice";
  // Already recorded: no need to ask Stripe for the card again. Recording checks again, under a lock.
  if (await stripePaymentRecorded(orgId, sessionId)) return "duplicate_payment";
  const paymentIntentId = str(session.payment_intent);
  const charge = paymentIntentId ? await chargeFor(accountId, paymentIntentId) : null;
  const result = await recordStripePayment(orgId, { invoiceId, amountCents: amount, checkoutSessionId: sessionId, paymentIntentId, card: charge?.card ?? null }, deps);
  if (result.kind === "duplicate") return "duplicate_payment";
  // Newly recorded, so this runs once per payment: the customer's emailed receipt, when checkout had to collect the address.
  if (result.kind !== "void_invoice" && charge) await emailReceipt(accountId, charge, session);
  // The owners and admins hear about it; quiet hours hold the text until morning.
  await notifyOwners(orgId, (member: Member) => stripePaidText(result, amount, isLanguage(member.language) ? member.language : "en"), "proactive", deps).catch(
    (error) => console.error("stripe: paid notice failed", error),
  );
  return result.kind === "recorded" ? "payment" : `payment:${result.kind}`;
}

/**
 * Records a refund the business made in its Stripe dashboard on one of our card payments, from the
 * charge's running `amount_refunded`, and texts the owners. A charge we didn't take is left alone.
 */
async function refundFromCharge(orgId: string, charge: Record<string, unknown>, deps?: { now?: Date }): Promise<string> {
  const paymentIntentId = str(charge.payment_intent);
  const refunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : null;
  if (!paymentIntentId || refunded === null) return "ignored:incomplete";
  const result = await recordStripeRefund(orgId, { paymentIntentId, amountRefundedCents: refunded }, deps);
  if (result.kind !== "recorded") return `refund:${result.kind}`;
  const invoice = result.invoiceId ? await getInvoice(orgId, result.invoiceId) : null;
  const [quote] = !invoice && result.quoteId
    ? await db().select({ title: quotes.title }).from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, result.quoteId)))
    : [];
  const what = invoice?.label ?? quote?.title ?? null;
  await notifyOwners(
    orgId,
    (member: Member) => stripeRefundText({ amountCents: result.refundedCents, what }, isLanguage(member.language) ? member.language : "en"),
    "proactive",
    deps,
  ).catch((error) => console.error("stripe: refund notice failed", error));
  return result.full ? "refund:full" : "refund:partial";
}

/**
 * Records the deposit a paid Checkout Session made on a quote's link, like `paymentFromSession` does an
 * invoice's payment: once, whichever of the webhook and the customer's return lands first, with its card,
 * Stripe's emailed receipt, and a text to the owners.
 */
async function depositFromSession(orgId: string, accountId: string, session: Record<string, unknown>, deps?: { now?: Date }): Promise<string> {
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const quoteId = str(metadata.quoteId);
  const sessionId = str(session.id);
  const amount = typeof session.amount_total === "number" ? session.amount_total : null;
  if (!quoteId || !sessionId || amount === null || amount <= 0) return "ignored:incomplete";
  if (str(metadata.orgId) !== orgId) {
    console.error("stripe: a session's business doesn't match its account", { orgId, sessionId });
    return "ignored:org_mismatch";
  }
  if (str(session.currency)?.toLowerCase() !== "usd") return "ignored:currency";
  const [quote] = await db().select().from(quotes).where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (!quote) return "ignored:no_quote";
  if (await stripePaymentRecorded(orgId, sessionId)) return "duplicate_payment";
  const paymentIntentId = str(session.payment_intent);
  const charge = paymentIntentId ? await chargeFor(accountId, paymentIntentId) : null;
  const result = await recordStripeDeposit(orgId, { quoteId, amountCents: amount, checkoutSessionId: sessionId, paymentIntentId, card: charge?.card ?? null }, deps);
  if (result.kind === "duplicate") return "duplicate_payment";
  if (charge) await emailReceipt(accountId, charge, session);
  const customer = quote.customerId ? await getCustomer(orgId, quote.customerId) : null;
  const invoice = result.invoiceId ? await getInvoice(orgId, result.invoiceId) : null;
  await notifyOwners(
    orgId,
    (member: Member) =>
      depositPaidText(
        {
          title: quote.title,
          customerName: customer?.name ?? null,
          signedName: quote.customerApprovedName,
          amountCents: amount,
          invoiceLabel: invoice?.label ?? null,
          overpaidCents: result.overpaidCents,
          closedQuote: result.closedQuote,
        },
        isLanguage(member.language) ? member.language : "en",
      ),
    "proactive",
    deps,
  ).catch((error) => console.error("stripe: deposit notice failed", error));
  return result.overpaidCents > 0 || result.closedQuote ? "deposit:refund" : "deposit";
}

/**
 * A payment's charge, for the card on its receipt and where its receipt is emailed. Asking Stripe can
 * fail; the payment is recorded anyway, without the card.
 */
async function chargeFor(accountId: string, paymentIntentId: string): Promise<ChargeDetails | null> {
  try {
    const charge = await stripeGateway().retrieveCharge({ accountId, paymentIntentId });
    if (!charge) return null;
    const brand = charge.card?.brand && /^[a-z_]{1,32}$/i.test(charge.card.brand) ? charge.card.brand.toLowerCase() : null;
    const last4 = charge.card?.last4 && /^\d{4}$/.test(charge.card.last4) ? charge.card.last4 : null;
    return { ...charge, card: brand || last4 ? { brand, last4 } : null };
  } catch (error) {
    console.error("stripe: charge lookup failed, recorded without the card", error);
    return null;
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

/**
 * Has Stripe email the customer a receipt from the business's account, when the charge has no receipt
 * email yet: no address was on file at checkout, so it goes to the one checkout collected. The address
 * is only handed to Stripe, never kept here. A failure is logged; the payment is already recorded.
 */
async function emailReceipt(accountId: string, charge: ChargeDetails, session: Record<string, unknown>): Promise<void> {
  if (charge.receiptEmail) return;
  const email = str((session.customer_details as Record<string, unknown> | null | undefined)?.email)?.trim();
  if (!email || email.length > 254 || !EMAIL.test(email)) return;
  try {
    await stripeGateway().setReceiptEmail({ accountId, chargeId: charge.chargeId, email });
  } catch (error) {
    console.error("stripe: receipt email failed", error);
  }
}

// ---------------------------------------------------------------------------------------------
// The customer's return from checkout

/** What the done page found: the payment's on the books, it's still clearing (a bank debit), or nothing to confirm. */
export type CheckoutConfirmation = "paid" | "processing" | "none";

/**
 * Confirms the checkout a customer just came back from, without waiting for Stripe's webhook. The session
 * id comes from the done page's URL, so it's never taken on trust: the session is fetched from Stripe on
 * the invoice's own business's connected account (another account's session isn't found there), and must
 * be for this very invoice of this business. A paid one is recorded through the webhook's own path, so
 * whichever lands first records it, once. A void invoice is left to the webhook, which tells the owner.
 */
export async function confirmCheckout(token: string, sessionId: string, deps?: { now?: Date }): Promise<CheckoutConfirmation> {
  if (!/^cs_\w{1,250}$/.test(sessionId) || !stripeMode()) return "none";
  const invoice = await invoiceByPayToken(token);
  if (!invoice || invoice.status === "draft" || invoice.status === "void") return "none";
  return confirmSession(invoice.orgId, sessionId, { key: "invoiceId", id: invoice.id }, deps);
}

/** Confirms the deposit checkout a customer just came back to their quote's link from, as `confirmCheckout` does an invoice's. */
export async function confirmDepositCheckout(token: string, sessionId: string, deps?: { now?: Date }): Promise<CheckoutConfirmation> {
  if (!/^cs_\w{1,250}$/.test(sessionId) || !stripeMode()) return "none";
  const quote = await quoteByCustomerToken(token);
  if (!quote) return "none";
  return confirmSession(quote.orgId, sessionId, { key: "quoteId", id: quote.id }, deps);
}

/**
 * Fetches the session from Stripe on the business's own connected account and records it if it's paid,
 * when it's for this very invoice or quote (`about`) of this business.
 */
async function confirmSession(
  orgId: string,
  sessionId: string,
  about: { key: "invoiceId" | "quoteId"; id: string },
  deps?: { now?: Date },
): Promise<CheckoutConfirmation> {
  const account = await getStripeAccount(orgId);
  if (!account) return "none";
  let session: Record<string, unknown> | null;
  try {
    session = await stripeGateway().retrieveCheckoutSession({ accountId: account.accountId, sessionId });
  } catch (error) {
    console.error("stripe: checkout session lookup failed", error);
    return "none";
  }
  if (!session) return "none";
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  if (str(session.id) !== sessionId || str(metadata[about.key]) !== about.id || str(metadata.orgId) !== orgId) {
    console.error("stripe: a returning session isn't this one's", { orgId, sessionId, about: about.key });
    return "none";
  }
  if (session.payment_status === "paid") {
    const outcome = await paymentFromSession(orgId, account.accountId, session, deps);
    return outcome === "duplicate_payment" || outcome.startsWith("deposit") || outcome.startsWith("payment") ? "paid" : "none";
  }
  return session.status === "complete" ? "processing" : "none";
}

/**
 * Delivers a fake event the way Stripe would: signed, over HTTP to this app's webhook. When the app
 * can't reach itself (a test without a server), it hands the same signed body to the handler directly.
 */
export async function deliverFakeEvent(origin: string, event: { type: string; account: string; object: Record<string, unknown> }): Promise<WebhookResult> {
  if (stripeMode() !== "fake") throw new Error("STRIPE_NOT_FAKE");
  const { body, signature } = signedEvent(event);
  try {
    const response = await fetch(`${origin}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return handleStripeWebhook(body, signature);
  }
}
