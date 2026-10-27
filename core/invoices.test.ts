process.env.BLOB_FAKE = "1";
process.env.STRIPE_FAKE = "1";

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { PDFDocument } from "pdf-lib";
import * as schema from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { morningLineText, runOrgTick } from "./followups";
import { setTransportForTests } from "./imessage";
import {
  balancesByCustomer,
  cardBrandName,
  cardText,
  createInvoice,
  getInvoice,
  invoicePhotos,
  invoiceTotals,
  isOverdue,
  listInvoices,
  owedText,
  readyToInvoice,
  recordPayment,
  recordStripePayment,
  removePayment,
  renderInvoice,
  resolveInvoiceId,
  sendInvoice,
  setInvoicePhotos,
  takeInvoiceNumber,
  updateInvoice,
  voidInvoice,
} from "./invoices";
import { addPhone, createMember, recordInbound, type Caller } from "./members";
import { createOrganization } from "./organizations";
import { saveItems, saveRule } from "./pricebook";
import { updateProfile } from "./profile";
import { approveQuote, createQuote, setQuoteOutcome, type Poster } from "./quotes";
import { closeServiceJob, createServiceJob } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";
import { addUploadedWorkPhoto, removeWorkPhoto } from "./work-photos";

let sent: Array<{ threadId: string; text: string }> = [];
let files = 0;
function install() {
  sent = [];
  files = 0;
  let n = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      sent.push({ threadId, text });
      return [`sent_${++n}`];
    },
    postFile: async () => {
      files++;
      return `file_${++n}`;
    },
    addReaction: async () => {},
  });
}
afterEach(() => setTransportForTests(null));

const quiet: Poster = async () => ({ posted: true });

async function person(name: string, role: Caller["role"], e164: string, orgId = TEST_ORG): Promise<Caller> {
  const member = await createMember({ orgId, name, role });
  const phone = await addPhone(orgId, member.id, e164);
  await recordInbound(orgId, phone.id, `thread:${e164}`, new Date(), "iMessage");
  return { orgId, memberId: member.id, name, role, language: "en", phoneE164: e164 };
}

/** An owner, a crew member, a customer, and an approved quote: 20 widgets at $12, a $50 rule, 7% tax. */
async function seed(orgId = TEST_ORG, n = 1) {
  install();
  const owner = await person("Pat Owner", "owner", `+1555555${n}100`, orgId);
  const crew = await person("Sam Crew", "member", `+1555555${n}101`, orgId);
  await updateProfile(orgId, { timeZone: "America/New_York", taxRateBp: 700, minimumChargeCents: 15000 }, owner.memberId);
  const [widget] = await saveItems(orgId, [{ name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const rule = await saveRule(orgId, { text: "Rush fee", kind: "pricing_modifier", effect: { op: "add_fixed", amount: 5000, appliesTo: "any" } }, owner.memberId);
  const customer = await saveCustomer(orgId, { name: "Jane Sample", address: "12 Oak St", email: "jane@example.test" }, owner.memberId);
  const quote = await createQuote(
    {
      title: "12 Oak St",
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      lines: [{ itemId: widget.id, quantity: 20 }],
      ruleIds: [rule.id],
      adjustments: [{ kind: "discount", amountCents: 1000, reason: "repeat customer" }],
    },
    owner,
    { post: quiet },
  );
  await approveQuote(quote.quoteId, owner, { post: quiet });
  return { owner, crew, widget, customer, quote };
}

withTestDb("an invoice from an agreed quote copies its lines and comes to the same total", async () => {
  const { owner, quote } = await seed();
  const { invoice, created } = await createInvoice(owner, { quoteId: quote.quoteId });
  assert.equal(created, true);
  assert.equal(invoice.label, "INV-0001");
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.customerName, "Jane Sample");
  // 20 × $12 = $240, + $50 rule = $290, − $10 = $280, + 7% tax = $299.60: the quote's own total.
  assert.equal(quote.totalCents, 29960);
  assert.equal(invoice.totalCents, quote.totalCents);
  assert.equal(invoice.taxCents, 1960);
  assert.deepEqual(invoice.ruleLines.map((r) => [r.label, r.cents]), [["Rush fee", 5000]]);
  assert.equal(invoice.balanceCents, 29960);
  assert.equal(invoice.issueDate, null);

  const again = await createInvoice(owner, { quoteId: quote.quoteId });
  assert.equal(again.created, false, "a quote is invoiced once");
  assert.equal(again.invoice.id, invoice.id);
});

withTestDb("a quote that isn't agreed yet, a crew member, and a line with no price are refused", async () => {
  const { owner, crew, widget, quote } = await seed();
  const draft = await createQuote({ title: "9 Elm Rd", lines: [{ itemId: widget.id, quantity: 2 }] }, owner, { post: quiet });
  await assert.rejects(createInvoice(owner, { quoteId: draft.quoteId }), /QUOTE_NOT_AGREED/);
  await assert.rejects(createInvoice(crew, { quoteId: quote.quoteId }), /NOT_PRIVILEGED/);
  await assert.rejects(createInvoice(owner, { title: "Cleanup", lines: [{ name: "Cleanup", quantity: 1 }] }), /INVOICE_NOT_PRICED/);
  await assert.rejects(createInvoice(owner, { title: "Cleanup" }), /NO_LINES/);
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await assert.rejects(recordPayment(crew, { invoiceId: invoice.id, amountCents: 100, method: "cash" }), /NOT_PRIVILEGED/);
  await assert.rejects(voidInvoice(crew, invoice.id), /NOT_PRIVILEGED/);
  await assert.rejects(sendInvoice(crew, invoice.id), /NOT_PRIVILEGED/);
});

withTestDb("finished work is ready to invoice until it's invoiced, from the revision it was agreed on", async () => {
  const { owner, quote } = await seed();
  await setQuoteOutcome(quote.quoteId, "won", owner, { post: quiet });
  const { job } = await createServiceJob(owner, { quoteId: quote.quoteId });
  assert.deepEqual(await readyToInvoice(TEST_ORG), [], "open work isn't ready yet");
  await closeServiceJob(owner, { jobId: job.id, status: "completed" }, { post: quiet });
  const ready = await readyToInvoice(TEST_ORG);
  assert.deepEqual(
    ready.map((r) => [r.jobId, r.quoteTotalCents]),
    [[job.id, 29960]],
  );
  const { invoice } = await createInvoice(owner, { serviceJobId: job.id });
  assert.equal(invoice.serviceJobId, job.id);
  assert.equal(invoice.quoteId, quote.quoteId);
  assert.equal(invoice.quoteRevisionId, job.quoteRevisionId);
  assert.equal(invoice.totalCents, 29960);
  assert.deepEqual(await readyToInvoice(TEST_ORG), []);
  // The same work asked for again, by its job or its quote, is the same invoice.
  assert.equal((await createInvoice(owner, { serviceJobId: job.id })).invoice.id, invoice.id);
  assert.equal((await createInvoice(owner, { quoteId: quote.quoteId })).invoice.id, invoice.id);
  // Voided, the work is ready to invoice again.
  await voidInvoice(owner, invoice.id);
  assert.equal((await readyToInvoice(TEST_ORG)).length, 1);
  const second = await createInvoice(owner, { serviceJobId: job.id });
  assert.equal(second.created, true);
  assert.equal(second.invoice.label, "INV-0002");
});

withTestDb("work with no quote needs its lines; a blank invoice uses stated and saved prices with the business's tax", async () => {
  const { owner, widget, customer } = await seed();
  const { job } = await createServiceJob(owner, { title: "Fence fix", customerId: customer.id });
  await assert.rejects(createInvoice(owner, { serviceJobId: job.id }), /NEEDS_LINES/);
  const { invoice } = await createInvoice(owner, {
    serviceJobId: job.id,
    lines: [
      { name: "Labor", quantity: 2, unitLabel: "hour", unitCents: 6000 },
      { itemId: widget.id, quantity: 1 },
    ],
  });
  // $120 + $12 = $132, no minimum on a written invoice, + 7% = $141.24.
  assert.equal(invoice.subtotalCents, 13200);
  assert.equal(invoice.minimumAppliedCents, 0);
  assert.equal(invoice.taxCents, 924);
  assert.equal(invoice.totalCents, 14124);
  assert.equal(invoice.customerName, "Jane Sample");
});

withTestDb("a draft's lines change; sending dates it by the payment terms and freezes it", async () => {
  const { owner, quote } = await seed();
  await updateProfile(TEST_ORG, { paymentTermsDays: 15 }, owner.memberId);
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  const edited = await updateInvoice(owner, invoice.id, { lines: [{ name: "Widget service", quantity: 10, unitCents: 1200 }], notes: "Thanks!" });
  // $120 + $50 rule = $170 (the $150 minimum doesn't apply), − $10 = $160, + 7% = $171.20.
  assert.equal(edited.totalCents, 17120);
  assert.equal(edited.notes, "Thanks!");

  const now = new Date("2026-10-20T16:00:00Z");
  const sentResult = await sendInvoice(owner, invoice.id, { now, post: quiet });
  assert.equal(sentResult.issued, true);
  assert.equal(sentResult.posted, true);
  assert.equal(sentResult.invoice.status, "sent");
  assert.equal(sentResult.invoice.issueDate, "2026-10-20");
  assert.equal(sentResult.invoice.dueDate, "2026-11-04");
  assert.ok(sentResult.invoice.pdfUrl?.startsWith("fake://invoices/"));
  await assert.rejects(updateInvoice(owner, invoice.id, { notes: "late" }), /INVOICE_NOT_DRAFT/);
  // Sending again re-sends it as it is; nothing changes.
  const resent = await sendInvoice(owner, invoice.id, { now: new Date("2026-10-25T16:00:00Z"), post: quiet });
  assert.equal(resent.issued, false);
  assert.equal(resent.invoice.issueDate, "2026-10-20");
});

withTestDb("sending posts the PDF and its caption to the member, never to the customer", async () => {
  const { owner, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id);
  assert.equal(files, 1, "the PDF is posted to the owner");
  assert.deepEqual(sent.map((s) => s.threadId), [`thread:${owner.phoneE164}`]);
  assert.match(sent[0].text, /Invoice INV-0001 for 12 Oak St: \$299\.60, due on receipt\./);
  assert.doesNotMatch(sent[0].text, /Pay online/, "no pay link without Stripe connected");
});

withTestDb("a $0 invoice isn't sent", async () => {
  const { owner } = await seed();
  const { invoice } = await createInvoice(owner, { title: "Warranty visit", lines: [{ name: "Warranty visit", quantity: 1, unitCents: 0 }] });
  await assert.rejects(sendInvoice(owner, invoice.id, { post: quiet }), /INVOICE_ZERO/);
  await assert.rejects(recordPayment(owner, { invoiceId: invoice.id, amountCents: 100, method: "cash" }), /OVERPAYMENT|INVOICE_ZERO/);
});

withTestDb("partial payments bring the balance down; more than the balance is refused", async () => {
  const { owner, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  // A payment on a draft issues it first.
  const first = await recordPayment(owner, { invoiceId: invoice.id, amountCents: 15000, method: "cash" });
  assert.equal(first.issued, true);
  assert.equal(first.invoice.status, "partially_paid");
  assert.equal(first.invoice.amountPaidCents, 15000);
  assert.equal(first.invoice.balanceCents, 14960);
  assert.ok(first.invoice.issueDate);
  await assert.rejects(recordPayment(owner, { invoiceId: invoice.id, amountCents: 14961, method: "check" }), /OVERPAYMENT: the balance is \$149\.60/);
  await assert.rejects(recordPayment(owner, { invoiceId: invoice.id, amountCents: 0, method: "cash" }), /INVALID_AMOUNT/);
  await assert.rejects(recordPayment(owner, { invoiceId: invoice.id, amountCents: 100, method: "cash", receivedDate: "2999-01-01" }), /INVALID_DATE/);
  const second = await recordPayment(owner, { invoiceId: invoice.id, amountCents: 14960, method: "check", reference: "#1042" });
  assert.equal(second.invoice.status, "paid");
  assert.equal(second.invoice.balanceCents, 0);
  assert.ok(second.invoice.paidAt);
  await assert.rejects(recordPayment(owner, { invoiceId: invoice.id, amountCents: 100, method: "cash" }), /INVOICE_PAID/);

  // A mistaken entry comes back off.
  const back = await removePayment(owner, second.payment.id);
  assert.equal(back.status, "partially_paid");
  assert.equal(back.balanceCents, 14960);
  assert.equal(back.paidAt, null);
  assert.equal(back.payments.filter((p) => !p.removedAt).length, 1);
  await assert.rejects(removePayment(owner, second.payment.id), /PAYMENT_NOT_FOUND/);
});

withTestDb("an invoice with payments can't be voided; without them it can, and stays void", async () => {
  const { owner, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id, { post: quiet });
  const paid = await recordPayment(owner, { invoiceId: invoice.id, amountCents: 5000, method: "cash" });
  await assert.rejects(voidInvoice(owner, invoice.id), /INVOICE_HAS_PAYMENTS/);
  await removePayment(owner, paid.payment.id);
  const voided = await voidInvoice(owner, invoice.id, { reason: "made twice" });
  assert.equal(voided.status, "void");
  assert.equal(voided.pdfUrl, null);
  assert.equal(voided.voidReason, "made twice");
  await assert.rejects(recordPayment(owner, { invoiceId: invoice.id, amountCents: 100, method: "cash" }), /INVOICE_VOID/);
  await assert.rejects(sendInvoice(owner, invoice.id, { post: quiet }), /INVOICE_VOID/);
});

withTestDb("a card payment is recorded once per checkout, as Stripe took it", async () => {
  const { owner, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id, { post: quiet });
  const paid = await recordStripePayment(TEST_ORG, { invoiceId: invoice.id, amountCents: 10000, checkoutSessionId: "cs_1", paymentIntentId: "pi_1" });
  assert.equal(paid.kind, "recorded");
  assert.equal((await recordStripePayment(TEST_ORG, { invoiceId: invoice.id, amountCents: 10000, checkoutSessionId: "cs_1", paymentIntentId: "pi_1" })).kind, "duplicate");
  // A cash payment lands meanwhile, then the customer pays an older checkout for the old balance.
  await recordPayment(owner, { invoiceId: invoice.id, amountCents: 10000, method: "cash" });
  const over = await recordStripePayment(TEST_ORG, { invoiceId: invoice.id, amountCents: 19960, checkoutSessionId: "cs_2", paymentIntentId: "pi_2" });
  assert.equal(over.kind, "overpaid");
  if (over.kind !== "overpaid") throw new Error("unreachable");
  assert.equal(over.overpaidCents, 10000);
  assert.equal(over.invoice.status, "paid");
  assert.equal(over.invoice.amountPaidCents, 39960);
  assert.equal(over.invoice.overpaidCents, 10000);
  // A card payment can't be removed here: it's refunded in Stripe.
  await assert.rejects(removePayment(owner, over.payment.id), /STRIPE_PAYMENT/);
  await assert.rejects(voidInvoice(owner, invoice.id), /INVOICE_HAS_PAYMENTS/);
});

withTestDb("money for a void invoice isn't recorded", async () => {
  const { owner, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id, { post: quiet });
  await voidInvoice(owner, invoice.id);
  const result = await recordStripePayment(TEST_ORG, { invoiceId: invoice.id, amountCents: 1000, checkoutSessionId: "cs_v", paymentIntentId: null });
  assert.equal(result.kind, "void_invoice");
  assert.equal((await getInvoice(TEST_ORG, invoice.id))?.amountPaidCents, 0);
});

withTestDb("invoice numbers are per business and never repeat, even made at once", async () => {
  const a = await seed(TEST_ORG, 1);
  await createOrganization({ id: "org_b", name: "Other Co", slug: "other-co" });
  const b = await seed("org_b", 2);
  const lines = [{ name: "Labor", quantity: 1, unitCents: 1000 }];
  const made = await Promise.all(Array.from({ length: 8 }, (_, i) => createInvoice(a.owner, { title: `Job ${i}`, lines })));
  assert.deepEqual(made.map((m) => m.invoice.number).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
  const other = await createInvoice(b.owner, { title: "Job", lines });
  assert.equal(other.invoice.label, "INV-0001", "the other business counts from 1");

  // Two connections take numbers at the same moment: the second waits for the first's lock.
  const url = process.env.DATABASE_URL as string;
  const one = postgres(url, { max: 1, prepare: false });
  const two = postgres(url, { max: 1, prepare: false });
  try {
    const first = drizzle(one, { schema });
    const second = drizzle(two, { schema });
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstTook!: () => void;
    const took = new Promise<void>((resolve) => (firstTook = resolve));
    const firstTx = first.transaction(async (tx) => {
      const n = await takeInvoiceNumber(tx, TEST_ORG);
      firstTook();
      await held;
      return n;
    });
    await took;
    let secondDone = false;
    const secondTx = second.transaction(async (tx) => takeInvoiceNumber(tx, TEST_ORG)).then((n) => {
      secondDone = true;
      return n;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(secondDone, false, "the second waits on the first's row lock");
    releaseFirst();
    const [n1, n2] = await Promise.all([firstTx, secondTx]);
    assert.deepEqual([n1, n2], [9, 10]);
  } finally {
    await one.end();
    await two.end();
  }
});

withTestDb("overdue is by the business's own calendar day", async () => {
  const { owner, quote } = await seed();
  await updateProfile(TEST_ORG, { timeZone: "America/Los_Angeles", paymentTermsDays: 0 }, owner.memberId);
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  // 9 PM Oct 20 in Los Angeles is already Oct 21 in UTC: it's issued and due Oct 20 there.
  const issuedAt = new Date("2026-10-21T04:00:00Z");
  const sent = await sendInvoice(owner, invoice.id, { now: issuedAt, post: quiet });
  assert.equal(sent.invoice.dueDate, "2026-10-20");
  const lateEvening = new Date("2026-10-21T06:30:00Z"); // 11:30 PM Oct 20 in Los Angeles
  assert.equal((await getInvoice(TEST_ORG, invoice.id, { now: lateEvening }))?.overdue, false);
  assert.equal((await listInvoices(TEST_ORG, { status: "overdue" }, { now: lateEvening })).length, 0);
  const nextMorning = new Date("2026-10-21T15:00:00Z"); // 8 AM Oct 21 there
  const next = await getInvoice(TEST_ORG, invoice.id, { now: nextMorning });
  assert.equal(next?.overdue, true);
  assert.equal(next?.daysOverdue, 1);
  assert.equal((await invoiceTotals(TEST_ORG, { now: nextMorning })).overdueCents, 29960);
  assert.equal(isOverdue({ status: "paid", dueDate: "2026-10-01" }, "2026-10-21"), false);
});

withTestDb("who owes what: open balances by customer, most first", async () => {
  const { owner, quote, customer } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id, { post: quiet });
  await recordPayment(owner, { invoiceId: invoice.id, amountCents: 15000, method: "cash" });
  const other = await saveCustomer(TEST_ORG, { name: "Bo Example" }, owner.memberId);
  const big = await createInvoice(owner, { title: "Deck", customerId: other.id, lines: [{ name: "Deck", quantity: 1, unitCents: 100000 }] });
  await sendInvoice(owner, big.invoice.id, { post: quiet });
  await createInvoice(owner, { title: "Draft only", customerId: customer.id, lines: [{ name: "X", quantity: 1, unitCents: 500 }] });

  const balances = await balancesByCustomer(TEST_ORG);
  assert.deepEqual(
    balances.map((b) => [b.name, b.balanceCents]),
    [
      ["Bo Example", 107000],
      ["Jane Sample", 14960],
    ],
  );
  const text = owedText(balances, "en");
  assert.match(text, /^2 customers owe \$1,219\.60:/);
  assert.match(text, /Bo Example \$1,070 \(INV-0002, due /);
  assert.match(owedText([], "es"), /Nadie te debe/);
  assert.equal(await resolveInvoiceId(TEST_ORG, "INV-0002"), big.invoice.id);
  assert.equal(await resolveInvoiceId(TEST_ORG, "invoice 2"), big.invoice.id);
  assert.equal(await resolveInvoiceId(TEST_ORG, "2"), big.invoice.id);
  assert.deepEqual((await listInvoices(TEST_ORG, { query: "Bo" })).map((i) => i.label), ["INV-0002"]);
  assert.deepEqual((await listInvoices(TEST_ORG, { query: "inv-1" })).map((i) => i.label), ["INV-0001"]);
});

withTestDb("the PDF has the number, totals, what's paid, and the balance", async () => {
  const { owner, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id, { post: quiet });
  await recordPayment(owner, { invoiceId: invoice.id, amountCents: 15000, method: "cash" });
  const rendered = await renderInvoice(TEST_ORG, invoice.id);
  const pdf = await PDFDocument.load(rendered.bytes);
  assert.equal(pdf.getTitle(), "Invoice INV-0001");
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(rendered.filename, "Invoice INV-0001 - 12 Oak St.pdf");
  const [row] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
  assert.equal(row.pdfUrl, rendered.pdfUrl);
});

// A 1×1 PNG, as a photo of the work.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const photoDir = mkdtempSync(join(tmpdir(), "gw-invoice-photos-"));

async function photoOf(actor: Caller, jobId: string, name: string): Promise<string> {
  const file = join(photoDir, `${jobId}-${name}`);
  writeFileSync(file, PNG);
  return (await addUploadedWorkPhoto(actor, { jobId }, { url: pathToFileURL(file).href, name, mimeType: "image/png" })).id;
}

withTestDb("photos of the work go on the invoice's PDF only as an owner picks them, until it's void", async () => {
  const { owner, crew, quote } = await seed();
  await setQuoteOutcome(quote.quoteId, "won", owner, { post: quiet });
  const { job } = await createServiceJob(owner, { quoteId: quote.quoteId });
  const before = await photoOf(crew, job.id, "before.png");
  const after = await photoOf(crew, job.id, "after.png");
  const porch = await photoOf(owner, job.id, "porch.png");
  // Invoiced from the quote: its work's photos are found through it. None are on the PDF to start.
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  assert.deepEqual((await invoicePhotos(TEST_ORG, invoice)).map((p) => [p.id, p.onPdf]), [[before, false], [after, false], [porch, false]]);

  // Chosen out of order, they keep the order they were taken in. A draft has no PDF to make again yet.
  const chosen = await setInvoicePhotos(owner, invoice.id, [porch, after, after]);
  assert.deepEqual(chosen.pdfPhotoIds, [after, porch]);
  assert.equal(chosen.pdfUrl, null);

  // Sent, the PDF has a page of them after the invoice.
  await sendInvoice(owner, invoice.id, { post: quiet });
  const sentPdf = await PDFDocument.load((await renderInvoice(TEST_ORG, invoice.id)).bytes);
  assert.equal(sentPdf.getPageCount(), 2);
  // Still changeable once sent: taking them off makes the PDF again, one page.
  const cleared = await setInvoicePhotos(owner, invoice.id, []);
  assert.deepEqual(cleared.pdfPhotoIds, []);
  assert.notEqual(cleared.pdfUrl, null);
  assert.equal((await PDFDocument.load((await renderInvoice(TEST_ORG, invoice.id)).bytes)).getPageCount(), 1);

  // A photo taken off the work drops off the PDF too.
  await setInvoicePhotos(owner, invoice.id, [before]);
  await removeWorkPhoto(owner, job.id, before);
  assert.equal((await PDFDocument.load((await renderInvoice(TEST_ORG, invoice.id)).bytes)).getPageCount(), 1);

  // Crew, a photo from other work, more than 8, an invoice for no work, and a void one are refused.
  await assert.rejects(setInvoicePhotos(crew, invoice.id, [after]), /NOT_PRIVILEGED/);
  const other = await createServiceJob(owner, { title: "Shed" });
  const elsewhere = await photoOf(owner, other.job.id, "shed.png");
  await assert.rejects(setInvoicePhotos(owner, invoice.id, [elsewhere]), /INVOICE_PHOTO_NOT_FOUND/);
  await assert.rejects(setInvoicePhotos(owner, invoice.id, Array.from({ length: 9 }, (_, i) => `wph_${i}`)), /INVOICE_PHOTO_LIMIT/);
  const blank = await createInvoice(owner, { title: "Cleanup", lines: [{ name: "Cleanup", quantity: 1, unitCents: 5000 }] });
  await assert.rejects(setInvoicePhotos(owner, blank.invoice.id, [after]), /INVOICE_NO_WORK/);
  await voidInvoice(owner, blank.invoice.id);
  await assert.rejects(setInvoicePhotos(owner, blank.invoice.id, []), /INVOICE_VOID/);
});

withTestDb("past-due invoices nudge the owner who sent them once per step, and quiet hours hold the nudge", async () => {
  const { owner, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id, { now: new Date("2026-10-20T15:00:00Z"), post: quiet }); // due Oct 20 in New York
  install();
  // Two days late: not yet (follow-up days is 3).
  await runOrgTick(TEST_ORG, new Date("2026-10-22T15:00:00Z"));
  assert.equal(sent.filter((s) => /past due/.test(s.text)).length, 0);
  // Three days late, at 10 PM: quiet hours hold it.
  await runOrgTick(TEST_ORG, new Date("2026-10-24T02:00:00Z"));
  assert.equal(sent.filter((s) => /past due/.test(s.text)).length, 0);
  // The next morning it goes, once.
  await runOrgTick(TEST_ORG, new Date("2026-10-24T14:00:00Z"));
  await runOrgTick(TEST_ORG, new Date("2026-10-24T15:00:00Z"));
  const nudges = sent.filter((s) => /past due/.test(s.text));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].text, /INV-0001 Jane Sample \$299\.60 \(4 days late\)/);
  assert.equal(nudges[0].threadId, `thread:${owner.phoneE164}`);
  // A week on, once more; paid, never again.
  await runOrgTick(TEST_ORG, new Date("2026-10-31T14:00:00Z"));
  assert.equal(sent.filter((s) => /past due/.test(s.text)).length, 2);
  await recordPayment(owner, { invoiceId: invoice.id, amountCents: 29960, method: "check" });
  await runOrgTick(TEST_ORG, new Date("2026-11-07T14:00:00Z"));
  assert.equal(sent.filter((s) => /past due/.test(s.text)).length, 2);
});

withTestDb("the morning line tells owners what's overdue, and crew nothing about invoices", async () => {
  const { owner, crew, quote } = await seed();
  const { invoice } = await createInvoice(owner, { quoteId: quote.quoteId });
  await sendInvoice(owner, invoice.id, { now: new Date("2026-10-20T15:00:00Z"), post: quiet });
  install();
  await runOrgTick(TEST_ORG, new Date("2026-10-22T12:00:00Z")); // 8 AM in New York
  const toOwner = sent.find((s) => s.threadId === `thread:${owner.phoneE164}` && s.text.startsWith("Good morning"));
  assert.match(toOwner?.text ?? "", /1 invoice overdue \(\$299\.60\)/);
  const toCrew = sent.find((s) => s.threadId === `thread:${crew.phoneE164}`);
  assert.doesNotMatch(toCrew?.text ?? "", /invoice/);
});

test("morningLineText adds overdue invoices in both languages", () => {
  const counts = { waitingOnCustomers: 0, waitingOnOwner: 0, drafts: 0, overdueInvoices: 2, overdueCents: 45000 };
  assert.equal(morningLineText(counts, "en"), "Good morning. 2 invoices overdue ($450).");
  assert.equal(morningLineText(counts, "es"), "Buenos días. 2 facturas vencidas ($450).");
});

test("a card prints the way people write it: brand and last four", () => {
  assert.deepEqual(
    ["visa", "mastercard", "amex", "discover", "AMEX", "diners", "union_pay"].map(cardBrandName),
    ["Visa", "Mastercard", "American Express", "Discover", "American Express", "Diners", "Union pay"],
  );
  assert.equal(cardText({ cardBrand: "visa", cardLast4: "4242" }), "Visa •••• 4242");
  assert.equal(cardText({ cardBrand: "amex", cardLast4: null }), "American Express");
  assert.equal(cardText({ cardBrand: "unknown", cardLast4: "0005" }), "•••• 0005");
  assert.equal(cardText({ cardBrand: null, cardLast4: null }), null);
});
