// Threads started on the web: on their own, for a new quote, or about a quote or customer the member can
// see. Each is a job under the member's thread with its session made up front, so the web can write in it.
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../schema/schema";
import { upsertThread } from "../../core/conversations";
import { saveCustomer } from "../../core/customers";
import { db } from "../../core/db";
import { getOwnJob, linkJobToQuote, setJobRunnerForTests, titleFromMessage, titleThreadFromMessage, type JobRunner } from "../../core/jobs";
import type { JobClaims } from "../../core/job-token";
import { APP_WEB } from "../../core/members";
import { saveItems } from "../../core/pricebook";
import { createInvoice } from "../../core/invoices";
import { createQuote } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { GET as listRoute, POST as startRoute } from "../../app/api/jobs/route";
import { GET as threadRoute } from "../../app/api/jobs/[id]/route";
import type { ThreadJson } from "./jobs";
import { call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

let created: JobClaims[] = [];
const fakeRunner: JobRunner = {
  async createSession(claims) {
    created.push(claims);
    return `ses_web_${created.length}`;
  },
  async send() {
    return { status: "replied", reply: "ok" };
  },
};
afterEach(() => setJobRunnerForTests(null));

async function seed() {
  installTransport();
  created = [];
  setJobRunnerForTests(fakeRunner);
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  for (const member of [owner, crew]) await upsertThread(TEST_ORG, member.memberId, `ses_${member.memberId}`);
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const customer = await saveCustomer(TEST_ORG, { name: "Example Customer" }, owner.memberId);
  const ownerQuote = await createQuote({ title: "1 Example St", customerId: customer.id, lines: [{ itemId: item.id, quantity: 2 }] }, owner, {
    post: async () => ({ posted: true }),
  });
  return { owner, crew, customer, ownerQuote, item };
}

const thread = (result: { body: Record<string, unknown> | null }) => result.body?.thread as ThreadJson;

withTestDb("a member starts a thread from the web, ready to write in, and it lists as theirs", async () => {
  const { owner } = await seed();
  const headers = await signIn(owner.phoneE164!);

  const started = await call(startRoute, headers, { body: { topic: "new" } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const made = thread(started);
  assert.equal(made.title, "New thread");
  assert.equal(made.topic, "new");
  assert.equal(made.mine, true);
  assert.ok(made.sessionId, "its session is made up front");
  assert.deepEqual(created.map((c) => c.conversationId), [made.id]);

  const job = await getOwnJob(TEST_ORG, owner.memberId, made.id);
  assert.equal(job?.kind, "job");
  assert.equal(job?.parentId, (await db().select().from(conversations).where(and(eq(conversations.memberId, owner.memberId), eq(conversations.kind, "thread"))))[0]?.id);

  const listed = await call(listRoute, headers);
  assert.deepEqual((listed.body?.threads as ThreadJson[]).map((t) => t.id), [made.id]);
  const one = await call(threadRoute, headers, { params: { id: made.id } });
  assert.equal(thread(one).sessionId, made.sessionId);

  const quoteThread = thread(await call(startRoute, headers, { body: { topic: "quote" } }));
  assert.equal(quoteThread.title, "New quote");
  assert.equal(quoteThread.topic, "quote");
});

withTestDb("Ask about this reopens the member's open thread on that quote or customer, titled after it", async () => {
  const { owner, customer, ownerQuote } = await seed();
  const headers = await signIn(owner.phoneE164!);

  const first = thread(await call(startRoute, headers, { body: { quoteId: ownerQuote.quoteId, reuse: true } }));
  assert.equal(first.title, "1 Example St");
  assert.equal(first.quote?.id, ownerQuote.quoteId);
  assert.equal(first.topic, null);
  const again = thread(await call(startRoute, headers, { body: { quoteId: ownerQuote.quoteId, reuse: true } }));
  assert.equal(again.id, first.id);
  const fresh = thread(await call(startRoute, headers, { body: { quoteId: ownerQuote.quoteId } }));
  assert.notEqual(fresh.id, first.id);

  const aboutCustomer = thread(await call(startRoute, headers, { body: { customerId: customer.id, reuse: true } }));
  assert.equal(aboutCustomer.title, "Example Customer");
  assert.equal(aboutCustomer.customer?.id, customer.id);
});

withTestDb("crew start threads, about anyone's quote too; nobody reaches another business's records", async () => {
  const { crew, ownerQuote } = await seed();
  const crewHeaders = await signIn(crew.phoneE164!);
  assert.equal(thread(await call(startRoute, crewHeaders, { body: { quoteId: ownerQuote.quoteId } })).quote?.id, ownerQuote.quoteId);
  assert.equal((await call(startRoute, crewHeaders, { body: { topic: "quote" } })).status, 201);

  const other = await otherBusiness();
  const outsider = await person("Lee Outsider", "owner", "+15555550109", other);
  await upsertThread(other, outsider.memberId, `ses_${outsider.memberId}`);
  const outsiderHeaders = await signIn(outsider.phoneE164!);
  refused(await call(startRoute, outsiderHeaders, { body: { quoteId: ownerQuote.quoteId } }), 404);
  const crewThread = thread(await call(startRoute, crewHeaders, { body: { topic: "new" } }));
  refused(await call(threadRoute, outsiderHeaders, { params: { id: crewThread.id } }), 404);

  refused(await call(startRoute, crewHeaders, { body: { topic: "new", title: "made up" } }), 400, "INVALID_INPUT");
  refused(await call(startRoute, await superAdminViewing(TEST_ORG), { body: { topic: "new" } }), 403, "NOT_A_MEMBER");
});

withTestDb("a member who hasn't texted yet has no thread to start one from", async () => {
  installTransport();
  setJobRunnerForTests(fakeRunner);
  const fresh = await person("Kim New", "owner", "+15555550103");
  refused(await call(startRoute, await signIn(fresh.phoneE164!), { body: { topic: "new" } }), 409, "NO_THREAD");
});

withTestDb("a member can start only so many threads an hour", async () => {
  const { owner } = await seed();
  const headers = await signIn(owner.phoneE164!);
  for (let i = 0; i < 30; i += 1) assert.equal((await call(startRoute, headers, { body: { topic: "new" } })).status, 201);
  refused(await call(startRoute, headers, { body: { topic: "new" } }), 429, "TOO_MANY_THREADS");
});

withTestDb("a new thread takes its name from the first message, and a new-quote thread from its quote", async () => {
  const { owner, item } = await seed();
  const headers = await signIn(owner.phoneE164!);

  const loose = thread(await call(startRoute, headers, { body: { topic: "new" } }));
  await titleThreadFromMessage(owner, loose.id, "What did we charge the Sample Ln house last spring for the back windows and screens?\nthanks");
  const named = (await getOwnJob(TEST_ORG, owner.memberId, loose.id))?.title;
  assert.equal(named, "What did we charge the Sample Ln house last spring for the…");
  await titleThreadFromMessage(owner, loose.id, "something else");
  assert.equal((await getOwnJob(TEST_ORG, owner.memberId, loose.id))?.title, named, "named once");

  const forQuote = thread(await call(startRoute, headers, { body: { topic: "quote" } }));
  await titleThreadFromMessage(owner, forQuote.id, "10 windows at 5 Sample Ln");
  assert.equal((await getOwnJob(TEST_ORG, owner.memberId, forQuote.id))?.title, "New quote", "a new-quote thread waits for its quote");
  const quote = await createQuote({ title: "5 Sample Ln", lines: [{ itemId: item.id, quantity: 10 }] }, owner, { post: async () => ({ posted: true }) });
  const auth = { authenticator: APP_WEB, principalId: "u", principalType: "user" as const, attributes: { conversationId: forQuote.id, conversationKind: "job" } };
  await linkJobToQuote(owner, auth, quote.quoteId);
  const linked = await getOwnJob(TEST_ORG, owner.memberId, forQuote.id);
  assert.equal(linked?.quoteId, quote.quoteId);
  assert.equal(linked?.title, "5 Sample Ln");

  assert.equal(titleFromMessage("   "), null);
  assert.equal(titleFromMessage("Short one"), "Short one");
});

withTestDb("Ask the assistant on an invoice opens a thread named after it, for its customer; a Billing thread names itself", async () => {
  const { owner, crew, customer } = await seed();
  const { invoice } = await createInvoice(owner, { title: "12 Example St", customerId: customer.id, lines: [{ name: "Sample service", quantity: 1, unitCents: 5000 }] });
  const headers = await signIn(owner.phoneE164!);

  const first = thread(await call(startRoute, headers, { body: { invoiceId: invoice.id, reuse: true } }));
  assert.equal(first.title, `${invoice.label} · 12 Example St`);
  assert.equal(first.customer?.id, customer.id);
  assert.equal(first.quote, null);
  const again = thread(await call(startRoute, headers, { body: { invoiceId: invoice.id, reuse: true } }));
  assert.equal(again.id, first.id, "reopens the open one");

  refused(await call(startRoute, await signIn(crew.phoneE164!), { body: { invoiceId: invoice.id } }), 404);
  refused(await call(startRoute, headers, { body: { invoiceId: "inv_nope" } }), 404);

  const billing = thread(await call(startRoute, headers, { body: { topic: "billing" } }));
  assert.equal(billing.title, "Billing");
  assert.equal(billing.topic, "billing");
  await titleThreadFromMessage(owner, billing.id, "Jane paid $150 cash");
  assert.equal((await getOwnJob(TEST_ORG, owner.memberId, billing.id))?.title, "Jane paid $150 cash");
});
