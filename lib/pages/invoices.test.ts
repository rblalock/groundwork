process.env.BLOB_FAKE = "1";
process.env.STRIPE_FAKE = "1";

import assert from "node:assert/strict";
import { saveCustomer } from "../../core/customers";
import { createInvoice, getInvoice } from "../../core/invoices";
import { saveItems } from "../../core/pricebook";
import { approveQuote, createQuote, setQuoteOutcome, type Poster } from "../../core/quotes";
import { closeServiceJob, createServiceJob } from "../../core/scheduling";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { addUploadedWorkPhoto } from "../../core/work-photos";
import { POST as createRoute } from "../../app/api/invoices/route";
import { GET as getRoute, PATCH as patchRoute } from "../../app/api/invoices/[id]/route";
import { POST as sendRoute } from "../../app/api/invoices/[id]/send/route";
import { POST as payRoute } from "../../app/api/invoices/[id]/payments/route";
import { DELETE as removePaymentRoute } from "../../app/api/invoices/[id]/payments/[paymentId]/route";
import { POST as voidRoute } from "../../app/api/invoices/[id]/void/route";
import { GET as pdfRoute } from "../../app/api/invoices/[id]/pdf/route";
import { PUT as photosRoute } from "../../app/api/invoices/[id]/photos/route";
import { POST as connectRoute } from "../../app/api/stripe/connect/route";
import { POST as disconnectRoute } from "../../app/api/stripe/disconnect/route";
import { customerInvoicesFor, invoicePhotosFor, invoicesFor, jobInvoicesFor, paymentsFor, quoteInvoiceFor } from "./invoices";
import { scheduleFor } from "./schedule";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const quiet: Poster = async () => ({ posted: true });

/** An owner's finished work from a won quote; a crew member; another business with its own invoice. */
async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  await person("Sam Crew", "member", "+15555550102");
  await person("Alex Admin", "admin", "+15555550103");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const customer = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "1 Sample St" }, owner.memberId);
  const quote = await createQuote({ title: "1 Sample St", customerId: customer.id, lines: [{ itemId: item.id, quantity: 10 }] }, owner, { post: quiet });
  await approveQuote(quote.quoteId, owner, { post: quiet });
  await setQuoteOutcome(quote.quoteId, "won", owner, { post: quiet });
  const { job } = await createServiceJob(owner, { quoteId: quote.quoteId });
  await closeServiceJob(owner, { jobId: job.id, status: "completed" }, { post: quiet });

  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  const theirs = await createInvoice(otherOwner, { title: "9 Other Rd", lines: [{ name: "Labor", quantity: 1, unitCents: 5000 }] });
  return { owner, customer, quote, job, theirs: theirs.invoice };
}

withTestDb("owners and admins invoice finished work, send it, take payments, and void through the routes", async () => {
  const s = await seed();
  const owner = await signIn("+15555550101");
  const admin = await signIn("+15555550103");

  const page = await invoicesFor(await appCaller(owner), {});
  assert.deepEqual(page.ready.map((r) => r.jobId), [s.job.id]);
  assert.deepEqual(page.invoices, [], "the other business's invoice isn't listed");

  const made = await call(createRoute, owner, { body: { serviceJobId: s.job.id } });
  assert.equal(made.status, 201);
  const id = made.body?.invoiceId as string;
  assert.equal((await call(createRoute, admin, { body: { quoteId: s.quote.quoteId } })).body?.invoiceId, id, "the same work, the same invoice");
  assert.equal((await invoicesFor(await appCaller(owner), {})).ready.length, 0);

  const edited = await call(patchRoute, owner, { method: "PATCH", params: { id }, body: { lines: [{ name: "Widget service", quantity: 5, unitCents: 1200 }] } });
  assert.equal(edited.status, 200);
  assert.equal((edited.body?.invoice as { totalCents: number }).totalCents, 6000);

  const sent = await call(sendRoute, owner, { params: { id }, body: {} });
  assert.equal(sent.status, 200);
  assert.equal(sent.body?.posted, true);
  refused(await call(patchRoute, owner, { method: "PATCH", params: { id }, body: { notes: "x" } }), 409, "INVOICE_NOT_DRAFT");

  const pdf = await call(pdfRoute, owner, { params: { id } });
  assert.equal(pdf.status, 404, "a fake:// PDF has no bytes to serve");

  refused(await call(payRoute, admin, { params: { id }, body: { amountCents: 6001, method: "cash" } }), 409, "OVERPAYMENT");
  const paid = await call(payRoute, admin, { params: { id }, body: { amountCents: 2500, method: "check", reference: "#12" } });
  assert.equal(paid.status, 201);
  const invoice = paid.body?.invoice as { status: string; balanceCents: number; payments: Array<{ id: string }> };
  assert.equal(invoice.status, "partially_paid");
  assert.equal(invoice.balanceCents, 3500);
  refused(await call(voidRoute, owner, { params: { id }, body: {} }), 409, "INVOICE_HAS_PAYMENTS");
  const paymentId = invoice.payments[0].id;
  refused(await call(removePaymentRoute, owner, { method: "DELETE", params: { id: s.theirs.id, paymentId } }), 404);
  assert.equal((await call(removePaymentRoute, owner, { method: "DELETE", params: { id, paymentId } })).status, 200);
  assert.equal((await call(voidRoute, owner, { params: { id }, body: {} })).status, 200);
  assert.equal((await getInvoice(TEST_ORG, id))?.status, "void");

  assert.deepEqual((await paymentsFor(await appCaller(owner))).payments.length, 0, "a removed payment isn't listed");
});

withTestDb("crew can't see or change invoices, payments, or Stripe; only a quote's invoice number and status reach them", async () => {
  const s = await seed();
  const owner = await signIn("+15555550101");
  const crew = await signIn("+15555550102");
  const id = (await call(createRoute, owner, { body: { serviceJobId: s.job.id } })).body?.invoiceId as string;
  refused(await call(createRoute, crew, { body: { serviceJobId: s.job.id } }), 403, "NOT_PRIVILEGED");
  refused(await call(getRoute, crew, { params: { id } }), 403);
  refused(await call(patchRoute, crew, { method: "PATCH", params: { id }, body: { notes: "x" } }), 403);
  refused(await call(sendRoute, crew, { params: { id }, body: {} }), 403);
  refused(await call(payRoute, crew, { params: { id }, body: { amountCents: 100, method: "cash" } }), 403);
  refused(await call(voidRoute, crew, { params: { id }, body: {} }), 403);
  refused(await call(pdfRoute, crew, { params: { id } }), 403);
  refused(await call(connectRoute, crew, { body: {} }), 403);
  refused(await call(disconnectRoute, crew, { body: {} }), 403);
  const crewCaller = await appCaller(crew);
  await assert.rejects(invoicesFor(crewCaller, {}), /Only the owner/);
  assert.equal(await customerInvoicesFor(crewCaller, s.customer.id), null);
  // A quote's invoice: crew see its number and status, not what's owed, and don't open or make one.
  const crewView = await quoteInvoiceFor(crewCaller, s.quote.quoteId, "won");
  assert.deepEqual(crewView, { invoice: { invoiceId: id, label: "INV-0001", status: "draft" }, canCreate: false, canOpen: false });
  assert.equal((await quoteInvoiceFor(await appCaller(owner), s.quote.quoteId, "won")).canOpen, true);
  assert.deepEqual(await jobInvoicesFor(crewCaller, [s.job.id]), {});
  assert.deepEqual((await scheduleFor(crewCaller, {})).invoices, {});
  assert.equal(Object.keys(await jobInvoicesFor(await appCaller(owner), [s.job.id])).length, 1);
});

withTestDb("another business's invoice is missing, and a super admin's view changes nothing", async () => {
  const s = await seed();
  const owner = await signIn("+15555550101");
  for (const result of [
    await call(getRoute, owner, { params: { id: s.theirs.id } }),
    await call(patchRoute, owner, { method: "PATCH", params: { id: s.theirs.id }, body: { notes: "x" } }),
    await call(sendRoute, owner, { params: { id: s.theirs.id }, body: {} }),
    await call(payRoute, owner, { params: { id: s.theirs.id }, body: { amountCents: 100, method: "cash" } }),
    await call(voidRoute, owner, { params: { id: s.theirs.id }, body: {} }),
    await call(pdfRoute, owner, { params: { id: s.theirs.id } }),
  ]) {
    refused(result, 404);
  }
  assert.equal((await getInvoice(s.theirs.orgId, s.theirs.id))?.notes, null);

  const admin = await superAdminViewing(TEST_ORG);
  assert.equal((await invoicesFor(await appCaller(admin), {})).ready.length, 1, "a super admin sees what an owner sees");
  refused(await call(createRoute, admin, { body: { serviceJobId: s.job.id } }), 403, "NOT_A_MEMBER");
  refused(await call(connectRoute, admin, { body: {} }), 403, "NOT_A_MEMBER");
});

withTestDb("connecting Stripe from Settings returns the onboarding page to open", async () => {
  await seed();
  const owner = await signIn("+15555550101");
  const started = await call(connectRoute, owner, { body: {} });
  assert.equal(started.status, 200);
  assert.match(String(started.body?.url), /\/api\/stripe\/fake\/onboard\?account=acct_fake_/);
  assert.equal((await call(disconnectRoute, owner, { body: {} })).status, 200);
});

withTestDb("finished work with no quote is invoiced from the page with what to bill; owners and admins only", async () => {
  const s = await seed();
  const owner = await signIn("+15555550101");
  const admin = await signIn("+15555550103");
  const crew = await signIn("+15555550102");
  const ownerActor = await appCaller(owner);
  const { job } = await createServiceJob(s.owner, { title: "2 Sample St", customerId: s.customer.id });
  await closeServiceJob(s.owner, { jobId: job.id, status: "completed" }, { post: quiet });
  await createServiceJob(s.owner, { title: "3 Sample St", customerId: s.customer.id }); // still open: not ready

  const ready = (await invoicesFor(ownerActor, {})).ready;
  assert.deepEqual(ready.map((r) => [r.jobId, r.quoteId]), [
    [s.job.id, s.quote.quoteId],
    [job.id, null],
  ]);

  // Without lines, the library refuses in the member's words; lines without work are refused too.
  refused(await call(createRoute, owner, { body: { serviceJobId: job.id } }), 409, "NEEDS_LINES");
  refused(await call(createRoute, owner, { body: { quoteId: s.quote.quoteId, lines: [{ name: "Labor", quantity: 1, unitCents: 100 }] } }), 400, "INVALID_INPUT");
  refused(await call(createRoute, owner, { body: { serviceJobId: job.id, lines: [] } }), 400, "INVALID_INPUT");
  refused(await call(createRoute, owner, { body: { serviceJobId: job.id, lines: [{ name: "Labor", quantity: 0, unitCents: 100 }] } }), 400, "INVALID_INPUT");
  const lines = [
    { name: "Labor", quantity: 2, unitLabel: "hour", unitCents: 4500 },
    { name: "Parts", quantity: 1, unitCents: 1250, taxable: false },
  ];
  refused(await call(createRoute, crew, { body: { serviceJobId: job.id, lines } }), 403, "NOT_PRIVILEGED");
  refused(await call(createRoute, await superAdminViewing(TEST_ORG), { body: { serviceJobId: job.id, lines } }), 403, "NOT_A_MEMBER");
  refused(await call(createRoute, owner, { body: { serviceJobId: "job_nope", lines } }), 404);

  const made = await call(createRoute, admin, { body: { serviceJobId: job.id, lines, notes: "Thanks!" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body?.invoiceId as string;
  const invoice = await getInvoice(TEST_ORG, id);
  assert.ok(invoice);
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.serviceJobId, job.id);
  assert.equal(invoice.quoteId, null);
  assert.equal(invoice.customerId, s.customer.id);
  assert.equal(invoice.title, "2 Sample St");
  assert.equal(invoice.notes, "Thanks!");
  assert.deepEqual(
    invoice.lines.map((l) => [l.name, l.quantity, l.unitCents]),
    [
      ["Labor", 2, 4500],
      ["Parts", 1, 1250],
    ],
  );
  assert.equal(invoice.subtotalCents, 10250);

  // Asking again returns the same invoice, and the work leaves "Ready to invoice".
  const again = await call(createRoute, owner, { body: { serviceJobId: job.id, lines: [{ name: "Other", quantity: 1, unitCents: 1 }] } });
  assert.deepEqual([again.status, again.body?.invoiceId], [200, id]);
  assert.equal((await getInvoice(TEST_ORG, id))?.subtotalCents, 10250, "the second ask changed nothing");
  assert.deepEqual((await invoicesFor(ownerActor, {})).ready.map((r) => r.jobId), [s.job.id]);
  assert.equal((await jobInvoicesFor(ownerActor, [job.id]))[job.id]?.invoiceId, id, "the visit details show it");

  // Another business's work isn't found.
  const theirJob = await createServiceJob(await person("Kim Other 2", "admin", "+15555550202", s.theirs.orgId), { title: "9 Other Rd" });
  refused(await call(createRoute, owner, { body: { serviceJobId: theirJob.job.id, lines } }), 404);
});

withTestDb("owners and admins choose the work's photos for the invoice's PDF from its page; crew can't", async () => {
  const s = await seed();
  const owner = await signIn("+15555550101");
  const photo = await addUploadedWorkPhoto(s.owner, { jobId: s.job.id }, { url: "https://example.test/after.png", name: "after.png", mimeType: "image/png" });
  const { invoice } = await createInvoice(s.owner, { serviceJobId: s.job.id });

  const put = await call(photosRoute, owner, { method: "PUT", params: { id: invoice.id }, body: { photoIds: [photo.id] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const photos = await invoicePhotosFor(await appCaller(owner), (await getInvoice(TEST_ORG, invoice.id))!);
  assert.deepEqual(photos.map((p) => [p.id, p.onPdf]), [[photo.id, true]]);

  refused(await call(photosRoute, owner, { method: "PUT", params: { id: invoice.id }, body: { photoIds: ["wph_nope"] } }), 409, "INVOICE_PHOTO_NOT_FOUND");
  refused(await call(photosRoute, owner, { method: "PUT", params: { id: invoice.id }, body: { photoIds: "all" } }), 400);
  refused(await call(photosRoute, await signIn("+15555550102"), { method: "PUT", params: { id: invoice.id }, body: { photoIds: [] } }), 403, "NOT_PRIVILEGED");
  refused(await call(photosRoute, await superAdminViewing(TEST_ORG), { method: "PUT", params: { id: invoice.id }, body: { photoIds: [] } }), 403);
  refused(await call(photosRoute, owner, { method: "PUT", params: { id: s.theirs.id }, body: { photoIds: [] } }), 404);
});
