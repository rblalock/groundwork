process.env.BLOB_FAKE = "1";
process.env.STRIPE_FAKE = "1";

import assert from "node:assert/strict";
import { invoicePage, quotePage } from "../../core/customer-page-test-support";
import { saveVersion } from "../../core/customer-pages";
import { saveCustomer } from "../../core/customers";
import { createInvoice, getInvoice } from "../../core/invoices";
import { approveQuote, createQuote, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { POST as previewRoute } from "../../app/api/customer-pages/[page]/preview/route";
import { POST as publishRoute } from "../../app/api/customer-pages/[page]/publish/route";
import { POST as restoreRoute } from "../../app/api/customer-pages/[page]/restore/route";
import { POST as standardRoute } from "../../app/api/customer-pages/[page]/standard/route";
import { POST as sendRoute } from "../../app/api/invoices/[id]/send/route";
import { GET as payViewRoute } from "../../app/pay/[token]/view/route";
import { GET as quoteViewRoute } from "../../app/q/[token]/view/route";
import { completeFakeOnboarding, refreshStripeAccount, startStripeConnect } from "../stripe";
import { customerPagesFor, editorFor } from "./customer-pages";
import { appCaller, call, installTransport, person, refused, signIn, superAdminViewing } from "./test-support";

const quiet: Poster = async () => ({ posted: true });

/** An owner with Stripe connected, an admin and crew, a quote out for approval, and a sent $120 invoice. */
async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  await person("Sam Crew", "member", "+15555550102");
  await person("Alex Admin", "admin", "+15555550103");
  const { url } = await startStripeConnect(TEST_ORG, owner.memberId);
  completeFakeOnboarding(new URL(url).searchParams.get("account") as string);
  assert.equal(await refreshStripeAccount(TEST_ORG), "active");
  const customer = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "1 Sample St" }, owner.memberId);
  const draft = await createQuote({ title: "Porch, 1 Sample St", customerId: customer.id, lines: [{ name: "Porch cleaning", unitLabel: "job", quantity: 1, unitCents: 40000 }] }, owner, { post: quiet });
  const approved = await approveQuote(draft.quoteId, owner, { post: quiet });
  assert.ok(approved.ok && approved.quote.customerLink);
  const quoteToken = approved.quote.customerLink.split("/q/")[1];
  const made = await createInvoice(owner, { title: "Gutters, 1 Sample St", customerId: customer.id, lines: [{ name: "Gutter cleaning", quantity: 1, unitCents: 12000 }] });
  return { owner, quoteToken, invoiceId: made.invoice.id };
}

const view = (handler: typeof quoteViewRoute, path: string, token: string) => handler(new Request(`http://localhost:3000${path}`), { params: Promise.resolve({ token }) });

withTestDb("owners and admins design a page from the editor, see it on a sample or their own quote, and publish it; customers see it filled in", async () => {
  const s = await seed();
  const owner = await signIn("+15555550101");
  const admin = await signIn("+15555550103");

  // The designer writes the page (agents/designer/agent/tools/write_customer_page.ts); the preview follows it as it's written.
  const writing = await call(previewRoute, owner, { params: { page: "quote" }, body: { html: quotePage("teal").slice(0, 160), source: "sample" } });
  assert.match(writing.body?.html as string, /Sample job/, "a half-written page fills too");
  assert.match(writing.body?.html as string, /http-equiv="Content-Security-Policy"/);
  const saved = await saveVersion(s.owner, "quote", quotePage("teal"), "Make it teal");
  assert.equal(saved.version, 1);
  const last = (await call(previewRoute, owner, { params: { page: "quote" }, body: {} })).body?.html as string;
  assert.match(last, /color:teal/);
  assert.doesNotMatch(last, /\{\{/);

  const sample = await call(previewRoute, admin, { params: { page: "quote" }, body: { source: "sample", state: "approved", language: "es" } });
  assert.match(sample.body?.html as string, /Trabajo de muestra/);
  assert.match(sample.body?.html as string, /<html lang="es">/);
  assert.match(sample.body?.html as string, /form-action &#39;none&#39;/, "nothing in a preview posts anywhere");
  const recent = await call(previewRoute, admin, { params: { page: "quote" }, body: { source: "recent" } });
  assert.match(recent.body?.html as string, /Porch, 1 Sample St/, "their newest real quote");
  assert.equal((await call(previewRoute, owner, { params: { page: "invoice" }, body: {} })).body?.html, null, "no design yet");

  const customerSees = async () => view(quoteViewRoute, `/q/${s.quoteToken}/view`, s.quoteToken);
  const before = await customerSees();
  assert.equal(before.status, 303, "a draft isn't what customers see");
  assert.match(before.headers.get("location") ?? "", new RegExp(`/q/${s.quoteToken}\\?standard=1$`));

  const published = await call(publishRoute, admin, { params: { page: "quote" }, body: {} });
  assert.equal((published.body?.state as { published: { version: number } }).published.version, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(await customerPagesFor(await appCaller(owner))).map(([page, state]) => [page, state.published?.version ?? null])),
    { quote: 1, invoice: null },
  );

  const live = await customerSees();
  assert.equal(live.status, 200);
  assert.match(live.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  const html = await live.text();
  assert.match(html, /Porch, 1 Sample St/);
  assert.match(html, /\$400\.00/);
  assert.match(html, new RegExp(`<form class="gw-form" action="/q/${s.quoteToken}/approve" method="post">`));
  assert.doesNotMatch(html, /\{\{|<script/);
  const changed = await view(quoteViewRoute, `/q/${s.quoteToken}/view?changed=1&name=1`, s.quoteToken);
  assert.match(await changed.text(), /was just updated[\s\S]*Type your name to approve/, "the approve form's notices come through");

  const restored = await call(restoreRoute, owner, { params: { page: "quote" }, body: { version: 1 } });
  assert.equal(restored.body?.version, 2);
  assert.equal((await editorFor(await appCaller(owner), "quote")).state.latest?.version, 2);

  const standard = await call(standardRoute, owner, { params: { page: "quote" } });
  assert.equal((standard.body?.state as { published: unknown }).published, null);
  assert.equal((await customerSees()).status, 303, "back to the standard page");
});

withTestDb("an invoice's pay link in the business's design has the real Pay button and the live balance", async () => {
  const s = await seed();
  const owner = await signIn("+15555550101");
  assert.equal((await call(sendRoute, owner, { params: { id: s.invoiceId }, body: {} })).status, 200);
  const token = (await getInvoice(TEST_ORG, s.invoiceId))!.payToken;

  await saveVersion(s.owner, "invoice", invoicePage("olive"), "olive");
  await call(publishRoute, owner, { params: { page: "invoice" }, body: { version: 1 } });

  const live = await view(payViewRoute, `/pay/${token}/view`, token);
  assert.equal(live.status, 200);
  const html = await live.text();
  assert.match(html, /color:olive/);
  assert.match(html, /\$120\.00/);
  assert.match(html, new RegExp(`<form class="gw-form" action="/pay/${token}/checkout" method="post"><button class="gw-button" type="submit">Pay \\$120\\.00 by card</button></form>`));
  const missing = await view(payViewRoute, "/pay/nope/view", "nope");
  assert.equal(missing.status, 303);
});

withTestDb("crew and a super admin looking on can't preview or publish pages", async () => {
  await seed();
  const crew = await signIn("+15555550102");
  const looking = await superAdminViewing(TEST_ORG);
  refused(await call(previewRoute, crew, { params: { page: "quote" }, body: {} }), 403, "NOT_PRIVILEGED");
  refused(await call(publishRoute, crew, { params: { page: "quote" }, body: {} }), 403, "NOT_PRIVILEGED");
  refused(await call(previewRoute, looking, { params: { page: "website" }, body: {} }), 400);
  refused(await call(publishRoute, looking, { params: { page: "quote" }, body: {} }), 403);
  const owner = await signIn("+15555550101");
  refused(await call(publishRoute, owner, { params: { page: "quote" }, body: {} }), 404, "PAGE_VERSION_NOT_FOUND");
  refused(await call(previewRoute, owner, { params: { page: "quote" }, body: { html: "x".repeat(400_000) } }), 400);
});
