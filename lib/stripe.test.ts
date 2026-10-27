process.env.BLOB_FAKE = "1";
process.env.STRIPE_FAKE = "1";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PDFDocument } from "pdf-lib";
import postgres from "postgres";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { invoices, payments, stripeAccounts, stripeEvents } from "../schema/schema";
import { saveCustomer } from "../core/customers";
import { db } from "../core/db";
import { setTransportForTests } from "../core/imessage";
import { createInvoice, getInvoice, recordPayment, sendInvoice, voidInvoice } from "../core/invoices";
import { addPhone, createMember, recordInbound, type Caller } from "../core/members";
import { createOrganization, setSuspended } from "../core/organizations";
import { updateProfile } from "../core/profile";
import { takesCardPayments } from "../core/stripe-connection";
import { TEST_ORG, withTestDb } from "../core/test-db";
import type { Poster } from "../core/quotes";
import { GET as receiptRoute } from "../app/pay/[token]/receipt/route";
import {
  checkoutSessionParams,
  completeFakeCheckout,
  completeFakeOnboarding,
  confirmCheckout,
  decodeFakeCheckout,
  disconnectStripe,
  encodeFakeCheckout,
  handleStripeWebhook,
  openCheckout,
  payPage,
  fakeReceiptEmails,
  refreshStripeAccount,
  setStripeGatewayForTests,
  signedEvent,
  startStripeConnect,
  stripeGateway,
  stripeSettings,
  type FakeCheckout,
  type StripeGateway,
} from "./stripe";

let sent: Array<{ threadId: string; text: string }> = [];
function install() {
  sent = [];
  let n = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      sent.push({ threadId, text });
      return [`sent_${++n}`];
    },
    postFile: async () => `file_${++n}`,
    addReaction: async () => {},
  });
}
afterEach(() => {
  setTransportForTests(null);
  setStripeGatewayForTests(null);
});
const quiet: Poster = async () => ({ posted: true });

async function owner(): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat Owner", role: "owner" });
  const phone = await addPhone(TEST_ORG, member.id, "+15555550100");
  await recordInbound(TEST_ORG, phone.id, "thread:+15555550100", new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name: "Pat Owner", role: "owner", language: "en", phoneE164: "+15555550100" };
}

/** An owner with a connected (fake) Stripe account and a sent $240 invoice for Jane. */
async function seed() {
  install();
  const pat = await owner();
  // No quiet hours, so the paid text goes out whenever the test runs.
  await updateProfile(TEST_ORG, { quietStartHour: 0, quietEndHour: 0 }, pat.memberId);
  const { url } = await startStripeConnect(TEST_ORG, pat.memberId);
  const account = new URL(url).searchParams.get("account") as string;
  completeFakeOnboarding(account);
  assert.equal(await refreshStripeAccount(TEST_ORG), "active");
  const customer = await saveCustomer(TEST_ORG, { name: "Jane Sample", email: "jane@example.test" }, pat.memberId);
  const { invoice } = await createInvoice(pat, { title: "12 Oak St", customerId: customer.id, lines: [{ name: "Windows", quantity: 20, unitCents: 1200 }] });
  await sendInvoice(pat, invoice.id, { post: quiet });
  return { pat, account, invoice: (await getInvoice(TEST_ORG, invoice.id))! };
}

function paidSession(account: string, invoice: { id: string }, amount: number, id = "1", orgId = TEST_ORG) {
  return signedEvent({
    id: `evt_${id}`,
    type: "checkout.session.completed",
    account,
    object: { id: `cs_${id}`, object: "checkout.session", amount_total: amount, currency: "usd", payment_status: "paid", payment_intent: `pi_${id}`, metadata: { orgId, invoiceId: invoice.id } },
  });
}

withTestDb("connecting a business's Stripe account: onboarding, active, disconnected, and back", async () => {
  const pat = await owner();
  assert.deepEqual(await stripeSettings(TEST_ORG), { available: true, fake: true, status: "not_connected", accountId: null });
  const first = await startStripeConnect(TEST_ORG, pat.memberId);
  assert.match(first.url, /^http:\/\/localhost:3000\/api\/stripe\/fake\/onboard\?account=acct_fake_/);
  const account = new URL(first.url).searchParams.get("account") as string;
  assert.equal((await stripeSettings(TEST_ORG)).status, "onboarding");
  assert.equal(await takesCardPayments(TEST_ORG), false);
  // Starting again continues with the same account.
  assert.equal(new URL((await startStripeConnect(TEST_ORG, pat.memberId)).url).searchParams.get("account"), account);
  // Stripe's account.updated, signed, turns it on.
  const { body, signature } = signedEvent({ type: "account.updated", account, object: { id: account, charges_enabled: true, details_submitted: true } });
  assert.equal((await handleStripeWebhook(body, signature)).status, 200);
  assert.equal((await stripeSettings(TEST_ORG)).status, "active");
  assert.equal(await takesCardPayments(TEST_ORG), true);
  await disconnectStripe(TEST_ORG, pat.memberId);
  assert.equal(await takesCardPayments(TEST_ORG), false);
  assert.equal((await stripeSettings(TEST_ORG)).status, "disconnected");
  await startStripeConnect(TEST_ORG, pat.memberId);
  const [row] = await db().select().from(stripeAccounts).where(eq(stripeAccounts.orgId, TEST_ORG));
  assert.equal(row.accountId, account, "connecting again picks the same account back up");
});

withTestDb("an invoice's pay link opens checkout for the balance as it is then", async () => {
  const { pat, account, invoice } = await seed();
  assert.ok(invoice.payUrl?.startsWith("http://localhost:3000/pay/"));
  const token = invoice.payToken;
  const page = await payPage(token);
  assert.equal(page.kind, "payable");
  if (page.kind !== "payable") throw new Error("unreachable");
  assert.equal(page.invoice.balanceCents, 24000);
  await recordPayment(pat, { invoiceId: invoice.id, amountCents: 4000, method: "cash" });
  const checkout = await openCheckout(token);
  assert.ok(checkout);
  const decoded = decodeFakeCheckout(new URL(checkout.url).searchParams.get("c") ?? "");
  assert.equal(decoded?.amountCents, 20000, "the balance after the cash");
  assert.equal(decoded?.accountId, account);
  assert.equal(decoded?.customerEmail, "jane@example.test");
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.stripeCheckoutSessionId, decoded?.sessionId);
  // A tampered checkout isn't the fake's.
  const forged = encodeFakeCheckout({ ...decoded!, amountCents: 1 }).replace(/\.[^.]+$/, ".bad");
  assert.equal(decodeFakeCheckout(forged), null);
  // Drafts and unknown tokens aren't pages; a void invoice can't be paid.
  assert.equal((await payPage("x".repeat(24))).kind, "not_found");
  await voidInvoice(pat, (await createInvoice(pat, { title: "Extra", lines: [{ name: "X", quantity: 1, unitCents: 100 }] })).invoice.id);
  const voided = await createInvoice(pat, { title: "Other", lines: [{ name: "X", quantity: 1, unitCents: 100 }] });
  assert.equal((await payPage(voided.invoice.payToken)).kind, "not_found", "a draft isn't the customer's yet");
});

withTestDb("a paid checkout's webhook records the payment once and texts the owner", async () => {
  const { account, invoice } = await seed();
  const { body, signature } = paidSession(account, invoice, 24000);
  const first = await handleStripeWebhook(body, signature);
  assert.deepEqual(first, { status: 200, body: { received: true, outcome: "payment" } });
  const paid = await getInvoice(TEST_ORG, invoice.id);
  assert.equal(paid?.status, "paid");
  assert.deepEqual(
    paid?.payments.map((p) => [p.source, p.method, p.amountCents, p.stripeCheckoutSessionId]),
    [["stripe", "card", 24000, "cs_1"]],
  );
  assert.ok(sent.some((s) => s.text === "Jane Sample paid $240 by card on INV-0001. Paid in full."), JSON.stringify(sent));
  // Stripe delivers it again: nothing changes, and nobody is texted twice.
  const before = sent.length;
  assert.deepEqual(await handleStripeWebhook(body, signature), { status: 200, body: { received: true, duplicate: true } });
  // The same session in a different event (async success after completed) records nothing new either.
  const again = signedEvent({
    id: "evt_async",
    type: "checkout.session.async_payment_succeeded",
    account,
    object: { id: "cs_1", amount_total: 24000, currency: "usd", payment_status: "paid", metadata: { orgId: TEST_ORG, invoiceId: invoice.id } },
  });
  assert.equal((await handleStripeWebhook(again.body, again.signature)).body.outcome, "duplicate_payment");
  assert.equal(sent.length, before);
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.amountPaidCents, 24000);
  const events = await db().select().from(stripeEvents).where(eq(stripeEvents.orgId, TEST_ORG));
  assert.deepEqual(events.map((e) => e.eventId).sort(), ["evt_1", "evt_async"]);
});

function refundedCharge(account: string, id: string, paymentIntent: string, amountRefunded: number) {
  return signedEvent({
    id: `evt_${id}`,
    type: "charge.refunded",
    account,
    object: { id: `ch_${id}`, object: "charge", payment_intent: paymentIntent, amount_refunded: amountRefunded, currency: "usd" },
  });
}

withTestDb("a refund made in Stripe takes the payment down, then off, and the invoice's balance follows", async () => {
  const { pat, account, invoice } = await seed();
  const paid = paidSession(account, invoice, 24000);
  await handleStripeWebhook(paid.body, paid.signature);
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.status, "paid");

  const partial = refundedCharge(account, "r1", "pi_1", 4000);
  assert.equal((await handleStripeWebhook(partial.body, partial.signature)).body.outcome, "refund:partial");
  let now = await getInvoice(TEST_ORG, invoice.id);
  assert.equal(now?.amountPaidCents, 20000);
  assert.equal(now?.status, "partially_paid");
  assert.deepEqual(now?.payments.map((p) => [p.amountCents, p.refundedCents, p.removedAt === null]), [[20000, 4000, true]]);
  assert.ok(sent.some((s) => s.text === "Recorded a $40 refund on INV-0001 (made in Stripe)."), JSON.stringify(sent));

  // A later event carries the running total: only the new part counts, and an old total changes nothing.
  const stale = refundedCharge(account, "r0", "pi_1", 4000);
  assert.equal((await handleStripeWebhook(stale.body, stale.signature)).body.outcome, "refund:unchanged");
  const full = refundedCharge(account, "r2", "pi_1", 24000);
  assert.equal((await handleStripeWebhook(full.body, full.signature)).body.outcome, "refund:full");
  now = await getInvoice(TEST_ORG, invoice.id);
  assert.equal(now?.amountPaidCents, 0);
  assert.equal(now?.status, "sent");
  assert.equal(now?.paidAt, null);
  const [payment] = now!.payments;
  assert.equal(payment.refundedCents, 24000);
  assert.ok(payment.removedAt, "refunded in full, it's off the invoice");
  assert.equal(payment.removedByMemberId, null);

  // A refund on a charge that isn't one of ours is left alone.
  const stranger = refundedCharge(account, "r3", "pi_unknown", 500);
  assert.equal((await handleStripeWebhook(stranger.body, stranger.signature)).body.outcome, "refund:not_found");
  // With everything refunded, the invoice can be voided.
  assert.equal((await voidInvoice(pat, invoice.id)).status, "void");
});

withTestDb("a paused business still records a card payment, and texts nobody about it", async () => {
  const { account, invoice } = await seed();
  await setSuspended(TEST_ORG, true);
  const before = sent.length;
  const { body, signature } = paidSession(account, invoice, 24000);
  assert.deepEqual(await handleStripeWebhook(body, signature), { status: 200, body: { received: true, outcome: "payment" } });
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.status, "paid");
  assert.equal(sent.length, before);
});

withTestDb("a bad signature is refused before anything is read", async () => {
  const { account, invoice } = await seed();
  const { body, signature } = paidSession(account, invoice, 24000);
  assert.equal((await handleStripeWebhook(body, null)).status, 400);
  assert.equal((await handleStripeWebhook(body, signature.replace(/v1=[0-9a-f]{4}/, "v1=0000"))).status, 400);
  assert.equal((await handleStripeWebhook(body.replace("24000", "1"), signature)).status, 400, "a changed body breaks the signature");
  const wrongSecret = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_someone_else" });
  assert.equal((await handleStripeWebhook(body, wrongSecret)).status, 400);
  const old = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_fake_local_only", timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await handleStripeWebhook(body, old)).status, 400, "an old signature is a replay");
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.amountPaidCents, 0);
});

withTestDb("a card payment for an old balance is recorded as taken, and the owner is told to refund the difference", async () => {
  const { pat, account, invoice } = await seed();
  // The customer opened checkout for $240; then $100 cash was recorded; then they paid the $240.
  await recordPayment(pat, { invoiceId: invoice.id, amountCents: 10000, method: "cash" });
  const { body, signature } = paidSession(account, invoice, 24000, "over");
  assert.equal((await handleStripeWebhook(body, signature)).body.outcome, "payment:overpaid");
  const after = await getInvoice(TEST_ORG, invoice.id);
  assert.equal(after?.status, "paid");
  assert.equal(after?.overpaidCents, 10000);
  assert.ok(sent.some((s) => s.text === "Jane Sample paid $240 by card on INV-0001, $100 more than was owed. Refund the difference in Stripe."));
  // Less than the balance is a partial payment.
  const { invoice: second } = await createInvoice(pat, { title: "Fence", lines: [{ name: "Fence", quantity: 1, unitCents: 50000 }] });
  await sendInvoice(pat, second.id, { post: quiet });
  const partial = paidSession(account, second, 20000, "part");
  assert.equal((await handleStripeWebhook(partial.body, partial.signature)).body.outcome, "payment");
  assert.equal((await getInvoice(TEST_ORG, second.id))?.status, "partially_paid");
  // A currency other than dollars isn't recorded.
  const euros = signedEvent({
    id: "evt_eur",
    type: "checkout.session.completed",
    account,
    object: { id: "cs_eur", amount_total: 100, currency: "eur", payment_status: "paid", metadata: { orgId: TEST_ORG, invoiceId: second.id } },
  });
  assert.equal((await handleStripeWebhook(euros.body, euros.signature)).body.outcome, "ignored:currency");
  assert.equal((await getInvoice(TEST_ORG, second.id))?.amountPaidCents, 20000);
});

withTestDb("an unpaid checkout, a platform event, and an unknown account record nothing", async () => {
  const { account, invoice } = await seed();
  const unpaid = signedEvent({
    id: "evt_unpaid",
    type: "checkout.session.completed",
    account,
    object: { id: "cs_u", amount_total: 24000, currency: "usd", payment_status: "unpaid", metadata: { orgId: TEST_ORG, invoiceId: invoice.id } },
  });
  assert.equal((await handleStripeWebhook(unpaid.body, unpaid.signature)).body.outcome, "awaiting_payment");
  const body = JSON.stringify({ id: "evt_platform", object: "event", type: "checkout.session.completed", data: { object: {} } });
  const platform = await handleStripeWebhook(body, Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_fake_local_only" }));
  assert.equal(platform.body.ignored, "platform event");
  const stranger = paidSession("acct_fake_00", invoice, 24000, "s");
  assert.equal((await handleStripeWebhook(stranger.body, stranger.signature)).body.ignored, "unknown account");
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.amountPaidCents, 0);
});

test("STRIPE_FAKE off and no keys: Stripe isn't set up", async () => {
  const saved = { fake: process.env.STRIPE_FAKE, key: process.env.STRIPE_SECRET_KEY, secret: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_FAKE = "";
  process.env.STRIPE_SECRET_KEY = "";
  process.env.STRIPE_WEBHOOK_SECRET = "";
  try {
    assert.equal((await handleStripeWebhook("{}", "t=1,v1=x")).status, 503);
  } finally {
    process.env.STRIPE_FAKE = saved.fake;
    process.env.STRIPE_SECRET_KEY = saved.key;
    process.env.STRIPE_WEBHOOK_SECRET = saved.secret;
  }
});

// ---------------------------------------------------------------------------------------------
// The customer's return from checkout, the card, and the receipt

/** Opens checkout on the pay link as the customer would, and returns the fake's session for it. */
async function checkoutFor(token: string): Promise<FakeCheckout> {
  const checkout = await openCheckout(token);
  assert.ok(checkout);
  const decoded = decodeFakeCheckout(new URL(checkout.url).searchParams.get("c") ?? "");
  assert.ok(decoded);
  return decoded;
}

const paidTexts = () => sent.filter((s) => / paid \$[\d,.]+ by card on /.test(s.text));
const paymentRows = (invoiceId: string) => db().select().from(payments).where(and(eq(payments.orgId, TEST_ORG), eq(payments.invoiceId, invoiceId)));

/** A gateway like the fake, with some calls swapped. */
function fakeWith(overrides: Partial<StripeGateway>): StripeGateway {
  return { ...stripeGateway(), ...overrides };
}

/** Another business, with its own connected account and a sent invoice: what must never cross over. */
async function otherBusinessWithInvoice() {
  const orgId = "org_other";
  await createOrganization({ id: orgId, name: "Other Co", slug: "other-co" });
  const member = await createMember({ orgId, name: "Kim Other", role: "owner" });
  const kim: Caller = { orgId, memberId: member.id, name: "Kim Other", role: "owner", language: "en", phoneE164: "+15555550200" };
  const { url } = await startStripeConnect(orgId, member.id);
  const account = new URL(url).searchParams.get("account") as string;
  completeFakeOnboarding(account);
  await refreshStripeAccount(orgId);
  const { invoice } = await createInvoice(kim, { title: "9 Other Rd", lines: [{ name: "Labor", quantity: 1, unitCents: 5000 }] });
  await sendInvoice(kim, invoice.id, { post: quiet });
  return { orgId, account, invoice: (await getInvoice(orgId, invoice.id))! };
}

withTestDb("the done page confirms a paid checkout: recorded once with its card, and the webhook after it is a duplicate", async () => {
  const { account, invoice } = await seed();
  const token = invoice.payToken;
  const checkout = await checkoutFor(token);
  assert.equal(checkout.successUrl, `http://localhost:3000/pay/${token}/done?session_id={CHECKOUT_SESSION_ID}`);
  // Back before paying (or a guessed URL): nothing to confirm.
  assert.equal(await confirmCheckout(token, checkout.sessionId), "none");
  assert.equal((await paymentRows(invoice.id)).length, 0);

  const session = completeFakeCheckout(checkout);
  assert.equal(await confirmCheckout(token, checkout.sessionId), "paid");
  const [payment] = await paymentRows(invoice.id);
  assert.deepEqual([payment.amountCents, payment.cardBrand, payment.cardLast4, payment.stripeCheckoutSessionId], [24000, "visa", "4242", checkout.sessionId]);
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.status, "paid");
  assert.equal(paidTexts().length, 1, JSON.stringify(sent));

  // A reload confirms again without recording or texting again.
  assert.equal(await confirmCheckout(token, checkout.sessionId), "paid");
  // Stripe's webhook lands after it: a duplicate.
  const { body, signature } = signedEvent({ id: "evt_late", type: "checkout.session.completed", account, object: session });
  assert.equal((await handleStripeWebhook(body, signature)).body.outcome, "duplicate_payment");
  assert.equal((await paymentRows(invoice.id)).length, 1);
  assert.equal(paidTexts().length, 1, "the owner is texted once");

  const page = await payPage(token);
  if (page.kind !== "paid") throw new Error(`expected paid, got ${page.kind}`);
  assert.deepEqual(
    page.payments.map((p) => [p.method, p.card, p.amountCents]),
    [["card", "Visa •••• 4242", 24000]],
  );
  assert.equal(page.invoice.paidCents, 24000);
});

withTestDb("the webhook first, then the done page: one payment, one text", async () => {
  const { account, invoice } = await seed();
  const checkout = await checkoutFor(invoice.payToken);
  const session = completeFakeCheckout(checkout);
  const { body, signature } = signedEvent({ id: "evt_first", type: "checkout.session.completed", account, object: session });
  assert.equal((await handleStripeWebhook(body, signature)).body.outcome, "payment");
  assert.equal(await confirmCheckout(invoice.payToken, checkout.sessionId), "paid");
  assert.equal((await paymentRows(invoice.id)).length, 1);
  assert.equal(paidTexts().length, 1);
});

withTestDb("the webhook and the done page at the same moment record one payment and text once", async () => {
  const { account, invoice } = await seed();
  const checkout = await checkoutFor(invoice.payToken);
  const session = completeFakeCheckout(checkout);
  const { body, signature } = signedEvent({ id: "evt_race", type: "checkout.session.completed", account, object: session });
  const [webhook, confirmed] = await Promise.all([handleStripeWebhook(body, signature), confirmCheckout(invoice.payToken, checkout.sessionId)]);
  assert.equal(confirmed, "paid");
  assert.ok(["payment", "duplicate_payment"].includes(String(webhook.body.outcome)));
  assert.equal((await paymentRows(invoice.id)).length, 1);
  assert.equal(paidTexts().length, 1);
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.amountPaidCents, 24000);
});

withTestDb("a payment being recorded on another connection is waited for, then found: no second payment, no second text", async () => {
  const { invoice } = await seed();
  const checkout = await checkoutFor(invoice.payToken);
  completeFakeCheckout(checkout);
  // Another process (the webhook, on another server) holds the invoice mid-recording.
  const other = postgres(process.env.DATABASE_URL as string, { prepare: false, max: 1 });
  try {
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const webhook = other.begin(async (tx) => {
      await tx`select id from invoices where org_id = ${TEST_ORG} and id = ${invoice.id} for update`;
      await tx`insert into payments (id, org_id, invoice_id, amount_cents, method, received_date, source, stripe_checkout_session_id)
               values ('pay_other_process', ${TEST_ORG}, ${invoice.id}, 24000, 'card', '2026-10-19', 'stripe', ${checkout.sessionId})`;
      await tx`update invoices set amount_paid_cents = 24000, status = 'paid' where org_id = ${TEST_ORG} and id = ${invoice.id}`;
      locked();
      await holding;
    });
    await isLocked;
    const confirming = confirmCheckout(invoice.payToken, checkout.sessionId);
    await sleep(150);
    release();
    await webhook;
    assert.equal(await confirming, "paid");
  } finally {
    await other.end();
  }
  assert.deepEqual((await paymentRows(invoice.id)).map((p) => p.id), ["pay_other_process"]);
  assert.equal(paidTexts().length, 0, "the other process texts the owner, not this one");
});

withTestDb("a returning session that isn't this invoice's, or this business's, records nothing", async () => {
  const { pat, invoice } = await seed();
  const token = invoice.payToken;
  // Another invoice of the same business, paid: its session can't confirm this one.
  const { invoice: second } = await createInvoice(pat, { title: "Fence", lines: [{ name: "Fence", quantity: 1, unitCents: 50000 }] });
  await sendInvoice(pat, second.id, { post: quiet });
  const secondCheckout = await checkoutFor((await getInvoice(TEST_ORG, second.id))!.payToken);
  completeFakeCheckout(secondCheckout);
  assert.equal(await confirmCheckout(token, secondCheckout.sessionId), "none");

  // Another business's paid session isn't found on this business's account, and this one's isn't found on theirs.
  const theirs = await otherBusinessWithInvoice();
  const theirCheckout = await checkoutFor(theirs.invoice.payToken);
  completeFakeCheckout(theirCheckout);
  assert.equal(await confirmCheckout(token, theirCheckout.sessionId), "none");
  const ours = await checkoutFor(token);
  completeFakeCheckout(ours);
  assert.equal(await confirmCheckout(theirs.invoice.payToken, ours.sessionId), "none");

  // A session on the right account whose metadata names another invoice, or another business, is refused.
  const session = (metadata: Record<string, string>) => ({
    id: "cs_forged",
    amount_total: 24000,
    currency: "usd",
    payment_status: "paid",
    status: "complete",
    payment_intent: "pi_forged",
    metadata,
  });
  setStripeGatewayForTests(fakeWith({ retrieveCheckoutSession: async () => session({ orgId: TEST_ORG, invoiceId: second.id }) }));
  assert.equal(await confirmCheckout(token, "cs_forged"), "none");
  setStripeGatewayForTests(fakeWith({ retrieveCheckoutSession: async () => session({ orgId: theirs.orgId, invoiceId: invoice.id }) }));
  assert.equal(await confirmCheckout(token, "cs_forged"), "none");
  setStripeGatewayForTests(null);

  // Unknown, malformed, and unknown-token ids confirm nothing.
  assert.equal(await confirmCheckout(token, "cs_fake_0000000000000000"), "none");
  assert.equal(await confirmCheckout(token, "not a session"), "none");
  assert.equal(await confirmCheckout("x".repeat(24), ours.sessionId), "none");

  for (const id of [invoice.id, second.id]) assert.equal((await paymentRows(id)).length, 0);
  const [otherPaid] = await db().select().from(payments).where(eq(payments.orgId, theirs.orgId));
  assert.equal(otherPaid, undefined);
  assert.equal(paidTexts().length, 0);
});

withTestDb("a session still clearing (a bank debit) shows as processing and records nothing", async () => {
  const { invoice } = await seed();
  const checkout = await checkoutFor(invoice.payToken);
  setStripeGatewayForTests(
    fakeWith({
      retrieveCheckoutSession: async () => ({
        id: checkout.sessionId,
        amount_total: 24000,
        currency: "usd",
        payment_status: "unpaid",
        status: "complete",
        payment_intent: "pi_debit",
        metadata: { orgId: TEST_ORG, invoiceId: invoice.id },
      }),
    }),
  );
  assert.equal(await confirmCheckout(invoice.payToken, checkout.sessionId), "processing");
  assert.equal((await paymentRows(invoice.id)).length, 0);
  assert.equal((await payPage(invoice.payToken)).kind, "payable");
});

withTestDb("a failing card lookup still records the payment, without the card", async () => {
  const { account, invoice } = await seed();
  setStripeGatewayForTests(
    fakeWith({
      retrieveCharge: async () => {
        throw new Error("Stripe is down");
      },
    }),
  );
  const { body, signature } = paidSession(account, invoice, 24000, "nocard");
  assert.equal((await handleStripeWebhook(body, signature)).body.outcome, "payment");
  const [payment] = await paymentRows(invoice.id);
  assert.deepEqual([payment.amountCents, payment.cardBrand, payment.cardLast4], [24000, null, null]);
  assert.equal(paidTexts().length, 1);
  const page = await payPage(invoice.payToken);
  if (page.kind === "not_found") throw new Error("unreachable");
  assert.deepEqual(page.payments.map((p) => [p.method, p.card]), [["card", null]], "the receipt says Card");
});

withTestDb("receipt emails: Stripe's, at checkout when the customer has an email, else on the charge once it's paid", async () => {
  const { pat, account, invoice } = await seed();
  // Jane has an email on file: checkout carries it as the payment's receipt email, and nothing more is asked.
  const before = fakeReceiptEmails().length;
  const checkout = await checkoutFor(invoice.payToken);
  assert.deepEqual(fakeReceiptEmails().slice(before), [{ via: "checkout", id: checkout.sessionId, email: "jane@example.test" }]);
  const params = checkoutSessionParams(checkout);
  assert.equal(params.payment_intent_data?.receipt_email, "jane@example.test");
  assert.equal(params.customer_email, "jane@example.test");
  completeFakeCheckout(checkout);
  assert.equal(await confirmCheckout(invoice.payToken, checkout.sessionId), "paid");
  assert.equal(fakeReceiptEmails().length, before + 1, "the charge already has its receipt email");

  // No email on file: checkout collects one, and once the payment is recorded the charge gets it.
  const { invoice: noEmail } = await createInvoice(pat, { title: "Gate", lines: [{ name: "Gate", quantity: 1, unitCents: 9000 }] });
  await sendInvoice(pat, noEmail.id, { post: quiet });
  const token = (await getInvoice(TEST_ORG, noEmail.id))!.payToken;
  const bare = await checkoutFor(token);
  assert.equal(bare.customerEmail, null);
  assert.equal(checkoutSessionParams(bare).payment_intent_data?.receipt_email, undefined);
  const session = completeFakeCheckout(bare, "sam@example.test");
  const mark = fakeReceiptEmails().length;
  assert.equal(await confirmCheckout(token, bare.sessionId), "paid");
  assert.deepEqual(fakeReceiptEmails().slice(mark), [{ via: "charge", id: bare.sessionId.replace(/^cs_/, "ch_"), email: "sam@example.test" }]);
  // The webhook after it is a duplicate: no second receipt. Nor does a reload send one.
  const { body, signature } = signedEvent({ id: "evt_dup", type: "checkout.session.completed", account, object: session });
  assert.equal((await handleStripeWebhook(body, signature)).body.outcome, "duplicate_payment");
  assert.equal(await confirmCheckout(token, bare.sessionId), "paid");
  assert.equal(fakeReceiptEmails().length, mark + 1);
  // The collected address goes only to Stripe: not to the customer record, not to the payment.
  const [payment] = await paymentRows(noEmail.id);
  assert.ok(!JSON.stringify(payment).includes("sam@example.test"));
});

withTestDb("a receipt email that fails doesn't stop the payment being recorded", async () => {
  const { pat } = await seed();
  const { invoice } = await createInvoice(pat, { title: "Gate", lines: [{ name: "Gate", quantity: 1, unitCents: 9000 }] });
  await sendInvoice(pat, invoice.id, { post: quiet });
  const token = (await getInvoice(TEST_ORG, invoice.id))!.payToken;
  const checkout = await checkoutFor(token);
  completeFakeCheckout(checkout, "sam@example.test");
  let asked = 0;
  setStripeGatewayForTests(
    fakeWith({
      setReceiptEmail: async () => {
        asked++;
        throw new Error("Stripe is down");
      },
    }),
  );
  assert.equal(await confirmCheckout(token, checkout.sessionId), "paid");
  assert.equal(asked, 1);
  const [payment] = await paymentRows(invoice.id);
  assert.deepEqual([payment.amountCents, payment.cardBrand], [9000, "visa"]);
  assert.equal(paidTexts().length, 1);
});

withTestDb("the receipt PDF: only for an issued invoice with something paid on it, in the invoice's language", async () => {
  const { pat, account, invoice } = await seed();
  const receipt = (token: string) => receiptRoute(new Request(`http://localhost:3000/pay/${token}/receipt`), { params: Promise.resolve({ token }) });
  // Unknown tokens, drafts, and an invoice nothing's been paid on have no receipt.
  assert.equal((await receipt("x".repeat(24))).status, 404);
  assert.equal((await receipt("../../etc")).status, 404);
  const { invoice: draft } = await createInvoice(pat, { title: "Draft", lines: [{ name: "X", quantity: 1, unitCents: 100 }] });
  assert.equal((await receipt(draft.payToken)).status, 404);
  assert.equal((await receipt(invoice.payToken)).status, 404, "sent, nothing paid");

  // A cash payment, then the rest by card: both on the receipt.
  await recordPayment(pat, { invoiceId: invoice.id, amountCents: 4000, method: "cash" });
  const partial = await payPage(invoice.payToken);
  if (partial.kind === "not_found") throw new Error("unreachable");
  assert.equal(partial.kind, "payable");
  assert.deepEqual(partial.payments.map((p) => [p.method, p.card, p.amountCents]), [["cash", null, 4000]]);
  assert.equal(partial.invoice.balanceCents, 20000);
  const { body, signature } = paidSession(account, invoice, 20000, "rest");
  assert.equal((await handleStripeWebhook(body, signature)).body.outcome, "payment");

  const response = await receipt(invoice.payToken);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-disposition") ?? "", /filename="Receipt INV-0001\.pdf"/);
  const pdf = await PDFDocument.load(new Uint8Array(await response.arrayBuffer()));
  assert.equal(pdf.getTitle(), "Receipt INV-0001");

  // A Spanish invoice's receipt is in Spanish.
  await db().update(invoices).set({ language: "es" }).where(and(eq(invoices.orgId, TEST_ORG), eq(invoices.id, invoice.id)));
  const es = await receipt(invoice.payToken);
  assert.match(es.headers.get("content-disposition") ?? "", /filename="Recibo INV-0001\.pdf"/);
  assert.equal((await PDFDocument.load(new Uint8Array(await es.arrayBuffer()))).getTitle(), "Recibo INV-0001");
});

withTestDb("a pay link's receipt is its own business's: another business's token shows only theirs", async () => {
  const { account, invoice } = await seed();
  const { body, signature } = paidSession(account, invoice, 24000);
  await handleStripeWebhook(body, signature);
  const theirs = await otherBusinessWithInvoice();
  const receipt = (token: string) => receiptRoute(new Request(`http://localhost:3000/pay/${token}/receipt`), { params: Promise.resolve({ token }) });
  assert.equal((await receipt(theirs.invoice.payToken)).status, 404, "nothing's been paid on theirs");
  const page = await payPage(theirs.invoice.payToken);
  if (page.kind === "not_found") throw new Error("unreachable");
  assert.deepEqual(page.payments, []);
  // A webhook from their account naming our invoice is refused.
  const crossed = signedEvent({
    id: "evt_crossed",
    type: "checkout.session.completed",
    account: theirs.account,
    object: { id: "cs_crossed", amount_total: 100, currency: "usd", payment_status: "paid", metadata: { orgId: TEST_ORG, invoiceId: invoice.id } },
  });
  assert.equal((await handleStripeWebhook(crossed.body, crossed.signature)).body.outcome, "ignored:org_mismatch");
  assert.equal((await paymentRows(invoice.id)).length, 1);
});
