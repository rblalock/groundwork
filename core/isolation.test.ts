// Two businesses in one database, with overlapping data: the same item names, customer, address, and
// quote titles. Everything business B does, through the libraries, the tools, and the channel, must
// never return or change a row of business A's. A data leak between businesses ends the product.
process.env.BLOB_FAKE = "1";
process.env.PHOTON_ADMIN_FAKE = "1";
process.env.EMAIL_FAKE = "1";
process.env.STRIPE_FAKE = "1";

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach } from "node:test";
import { pathToFileURL } from "node:url";
import * as upngModule from "@pdf-lib/upng";
import { eq, getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import * as schema from "../schema/schema";
import { ensureAgentSession } from "./agent-sessions";
import { archiveCustomer, customerHistory, getCustomer, mergeCustomers, removeContact, saveContact, saveCustomer, searchCustomers } from "./customers";
import { getNote, listNotes, saveNote } from "./notes";
import { searchRecords } from "./records";
import { handleAssistantMessage, handleInbound, handleReaction, memberAuth, type DispatchDeps } from "./channel-dispatch";
import { db } from "./db";
import { recordEvent } from "./events";
import { cancelFollowups, cancelNotices, dueNudges, queueNotice, runHourlyTick } from "./followups";
import { setTransportForTests } from "./imessage";
import {
  addPhone,
  createMember,
  findMemberById,
  findMemberByPhone,
  listMembers,
  privilegedMembers,
  reactivateMember,
  recordInbound,
  removeMember,
  resolveCaller,
  setMemberRole,
  setPhonePhoton,
  setPhoneStatus,
  type Caller,
} from "./members";
import { createOrganization, getOrganization } from "./organizations";
import { lastProactiveFor, logOutbound, notifyOwners, postToMember } from "./outbound";
import { findItemByName, listItems, listRules, retireRule, saveItems, saveRule, updateItem, versions } from "./pricebook";
import { bumpVersion, getProfile, updateProfile } from "./profile";
import { emailQuote } from "./quote-email";
import {
  approveQuote,
  askedApproval,
  createQuote,
  getQuote,
  linkRecentAttachments,
  setAsideRecentAttachments,
  listQuotes,
  loadSummary,
  pendingForMember,
  recentQuoteRef,
  renderCurrentPdf,
  requestOwnerApproval,
  reviseQuote,
  revisionNumberAt,
  setFollowup,
  setQuoteOutcome,
  turnQuoteRef,
  type Poster,
} from "./quotes";
import { latestInbound } from "./tool-context";
import { confirmedEmailForTests, withTestDb } from "./test-db";
import { requestLoginCode, verifyLoginCode } from "../lib/login-codes";
import { memberConversationForSession, upsertThread } from "./conversations";
import { activityFor, persistEvent } from "./conversation-events";
import { recordDelivery } from "./deliveries";
import { intakePhotonWebhook, photonDeliveryHandler, signPhotonWebhook } from "./photon-inbound";
import { agentMailGateway, agentMailWebhookSecret, fakeReceivedEvent, setAgentMailGatewayForTests, signAgentMailWebhook } from "./agentmail";
import { createBusinessInbox, intakeAgentMailWebhook } from "./email-intake";
import { startClaim } from "./email-claims";
import { processMember } from "./deliveries";
import { getOwnJob, jobsAbout, listJobs, openJob, runJobTurn, setJobRunnerForTests, setJobStatus } from "./jobs";
import type { JobClaims } from "./job-token";
import { recordUsage } from "./usage";
import { admitTurn, limitsFor, setUsageLimits, usageNow } from "./usage-limits";
import { monthlyUsage } from "./usage-report";
import addMemberTool from "../agents/assistant/agent/tools/add_member";
import findCustomerTool from "../agents/assistant/agent/tools/find_customer";
import getQuoteTool from "../agents/assistant/agent/tools/get_quote";
import listQuotesTool from "../agents/assistant/agent/tools/list_quotes";
import readBusinessTool from "../agents/assistant/agent/tools/read_business";
import setLogoTool from "../agents/assistant/agent/tools/set_logo";
import updateBrandingTool from "../agents/assistant/agent/tools/update_branding";
import readNoteTool from "../agents/assistant/agent/tools/read_note";
import searchRecordsTool from "../agents/assistant/agent/tools/search_records";
import saveNoteTool from "../agents/assistant/agent/tools/save_note";
import mergeCustomersTool from "../agents/assistant/agent/tools/merge_customers";
import { addUploadedWorkPhoto, attachTextedWorkPhotos, listWorkPhotos, removeWorkPhoto, workPhoto } from "./work-photos";
import { customerPageState, publishedTemplate, publishVersion, saveVersion } from "./customer-pages";
import { invoicePage } from "./customer-page-test-support";
import bookVisitTool from "../agents/assistant/agent/tools/book_visit";
import readScheduleTool from "../agents/assistant/agent/tools/read_schedule";
import {
  balancesByCustomer,
  createInvoice,
  getInvoice,
  invoiceForQuote,
  invoicesForJobs,
  invoiceTotals,
  listInvoices,
  listPayments,
  readyToInvoice,
  recordPayment,
  recordStripePayment,
  removePayment,
  resolveInvoiceId,
  sendInvoice,
  updateInvoice,
  voidInvoice,
} from "./invoices";
import { processStripeEvent } from "../lib/stripe";
import listInvoicesTool from "../agents/assistant/agent/tools/list_invoices";
import getInvoiceTool from "../agents/assistant/agent/tools/get_invoice";
import recordPaymentTool from "../agents/assistant/agent/tools/record_payment";
import {
  addTimeOff,
  bookVisit,
  changeVisitStatus,
  closeServiceJob,
  findAvailability,
  getServiceJob,
  getVisit,
  readSchedule,
  removeTimeOff,
  rescheduleVisit,
  serviceJobsAbout,
  setWorkHours,
  toSchedule,
} from "./scheduling";
import { listGlossary, removeGlossaryTerm, replaceGlossary, saveGlossaryTerm } from "./glossary";
import { setTranslatorForTests, translateTexts, type Translator } from "./translation";
import { businessFootprint, businessTables as removalTables, deleteBusiness } from "./business-removal";
import saveGlossaryTermTool from "../agents/assistant/agent/tools/save_glossary_term";

const UPNG = ((upngModule as unknown as { default?: { default?: typeof upngModule } }).default?.default ??
  (upngModule as unknown as { default?: typeof upngModule }).default ??
  upngModule) as typeof upngModule;

let sent: Array<{ threadId: string; text: string }> = [];
function install() {
  sent = [];
  let n = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      sent.push({ threadId, text });
      return [`sent_${++n}`];
    },
    postFile: async (threadId) => {
      sent.push({ threadId, text: "(file)" });
      return `file_${++n}`;
    },
    addReaction: async () => {},
  });
}
afterEach(() => {
  setTransportForTests(null);
  setTranslatorForTests(null);
});

/** Stands in for the model: every text is English, translated as `spanish`. */
const translatesAs = (spanish: string): Translator => async () => ({ sourceLanguage: "en", text: spanish });

/** Records quote posts instead of texting. */
const posts: Array<{ orgId: string; memberId: string }> = [];
const post: Poster = async (orgId, memberId) => {
  posts.push({ orgId, memberId });
  return { posted: true };
};

const SEEDED_AT = new Date("2026-10-20T16:00:00Z"); // 12:00 in New York, 09:00 in Los Angeles
const thread = (e164: string) => `thread:${e164}`;

type Business = Awaited<ReturnType<typeof seedBusiness>>;

/**
 * One business with a bit of everything, under the same names as the other. `n` keeps phones and
 * provider ids apart; prices differ so totals tell the businesses apart.
 */
async function seedBusiness(n: 1 | 2, timeZone: string, extraDraft = false) {
  const org = await createOrganization({ id: `org_${n}`, name: `Example Services ${n}`, slug: `example-services-${n}` });
  const orgId = org.id;
  const ownerPhone = `+155555501${n}0`;
  const crewPhone = `+155555501${n}1`;
  const ownerRow = await createMember({ orgId, name: "Pat Example", role: "owner" });
  const crewRow = await createMember({ orgId, name: `Sam Crew ${n}`, role: "member", addedByMemberId: ownerRow.id });
  const ownerPhoneRow = await addPhone(orgId, ownerRow.id, ownerPhone);
  const crewPhoneRow = await addPhone(orgId, crewRow.id, crewPhone);
  await recordInbound(orgId, ownerPhoneRow.id, thread(ownerPhone), new Date(), "iMessage");
  await recordInbound(orgId, crewPhoneRow.id, thread(crewPhone), new Date(), "iMessage");
  const caller = (m: typeof ownerRow, phone: string): Caller => ({
    orgId,
    memberId: m.id,
    name: m.name,
    role: m.role,
    language: "en",
    phoneE164: phone,
  });
  const owner = caller(ownerRow, ownerPhone);
  const crew = caller(crewRow, crewPhone);

  await updateProfile(orgId, { name: org.name, timeZone, minimumChargeCents: 1000 * n }, owner.memberId);
  const [widget, gadget] = await saveItems(
    orgId,
    [
      { name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1000 * n },
      { name: "Gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 200 * n },
    ],
    owner.memberId,
  );
  // A change log row: the gadget gets a note.
  await updateItem(orgId, gadget.id, { notes: "Bring the small kit" }, owner.memberId);
  const rule = await saveRule(
    orgId,
    { text: "Add $50 for rush jobs", kind: "pricing_modifier", effect: { op: "add_fixed", amount: 5000, appliesTo: "any" } },
    owner.memberId,
  );
  const customer = await saveCustomer(
    orgId,
    { name: "Jane Sample", phone: `+155555502${n}9`, email: `jane${n}@example.test`, address: "100 Example St" },
    owner.memberId,
  );
  const property = customer.properties[0];
  // A business-wide note and a site note on the property, under the same words in both businesses.
  const businessNote = await saveNote(owner, { title: "Sill wiping", body: "We always wipe the sills, no charge." });
  const siteNote = await saveNote(owner, { title: "Gate code", body: `Gate code ${n}${n}${n}${n}`, propertyId: property.id });

  // A photo the owner texted, then a draft that picks it up.
  const photoMessageId = `msg_photo_${n}`;
  await db().insert(schema.messages).values({
    id: photoMessageId,
    orgId,
    memberId: owner.memberId,
    phoneE164: ownerPhone,
    direction: "inbound",
    kind: "user",
    providerMessageId: `pm_in_${n}`,
    threadId: thread(ownerPhone),
    body: "photo",
    attachments: [{ type: "image", url: `fake://photo-${n}.jpg`, mimeType: "image/jpeg" }],
  });
  const draft = await createQuote(
    {
      title: "100 Example St",
      customerId: customer.id,
      propertyId: property.id,
      lines: [{ itemId: widget.id, quantity: 10 }],
      ruleIds: [rule.id],
    },
    owner,
    { post, now: SEEDED_AT, photosSince: new Date(Date.now() - 60_000) },
  );
  const approved = await createQuote(
    { title: "200 Sample Ave", customerId: customer.id, lines: [{ itemId: gadget.id, quantity: 20 }] },
    owner,
    { post, now: SEEDED_AT },
  );
  await approveQuote(approved.quoteId, owner, { post, now: SEEDED_AT });
  const crewDraft = await createQuote({ title: "100 Example St", lines: [{ itemId: widget.id, quantity: 4 }] }, crew, {
    post,
    now: SEEDED_AT,
  });
  await requestOwnerApproval(crewDraft.quoteId, crew, { post, now: SEEDED_AT });
  if (extraDraft) {
    await createQuote({ title: "300 Example Rd", lines: [{ itemId: widget.id, quantity: 2 }] }, owner, { post, now: SEEDED_AT });
  }

  // The reply that asked the owner to approve the draft, which a tapback can land on.
  await logOutbound({
    orgId,
    memberId: owner.memberId,
    phoneE164: ownerPhone,
    threadId: thread(ownerPhone),
    providerMessageIds: [`pm_out_${n}`],
    chunks: ["Quote for 100 Example St"],
    kind: "assistant",
    quoteId: draft.quoteId,
    asksApproval: true,
  });
  await logOutbound({
    orgId,
    memberId: owner.memberId,
    phoneE164: ownerPhone,
    threadId: thread(ownerPhone),
    providerMessageIds: [`pm_pro_${n}`],
    chunks: [`Business ${n} checking in`],
    kind: "proactive",
  });
  await recordEvent({ orgId, kind: "morning", key: "morning:shared:2026-10-19", memberId: owner.memberId });
  const { conversation: ownerThread } = await upsertThread(orgId, owner.memberId, `ses_${n}`);
  // A turn in the owner's thread, as eve's stream reports it, with the same event shape in both businesses.
  const ownerAuth = { authenticator: "photon-imessage", principalId: `member:${owner.memberId}`, attributes: { orgId, memberId: owner.memberId } };
  const persisted = await persistEvent(
    { type: "message.received", data: { turnId: `turn_${n}`, message: "quote 100 Example St" }, meta: { id: `evt_seed_${n}`, at: SEEDED_AT.toISOString() } },
    { id: `ses_${n}`, auth: ownerAuth },
  );
  assert.equal(persisted.recorded, 1);
  // An inbound text the queue handled, with the same shape in both businesses.
  await recordDelivery({ orgId, memberId: owner.memberId, providerMessageId: `pm_dlv_${n}`, kind: "message", threadId: thread(ownerPhone), payload: {} });
  // A job under the owner's thread, about the draft, with the same id shape in both businesses.
  await openJob(owner, { id: `job_${n}`, thread: ownerThread, title: "100 Example St", quoteId: draft.quoteId });
  // The same glossary in both businesses, and the same text translated in each, differently: a cache
  // read that missed the business would find the other's row.
  await saveGlossaryTerm(owner, { term: "widget", spanish: "artilugio" });
  setTranslatorForTests(translatesAs(`Cotización ${n}`));
  await translateTexts({ orgId, memberId: owner.memberId, conversationId: ownerThread.id, target: "es", texts: ["Quote for 100 Example St"] });
  setTranslatorForTests(null);
  await queueNotice({ orgId, memberId: owner.memberId, quoteId: null, payload: { text: `Notice ${n}`, asksApproval: false }, now: SEEDED_AT });
  // A web sign-in code, texted to the owner.
  const code = await requestLoginCode(ownerPhone, { post: async () => ({ posted: true }), generate: () => `00000${n}` });
  assert.equal(code.sent, true);
  // The approved quote's work, booked for the crew on the same day and time in both businesses, then
  // moved (a second revision), and the crew's time off the day after.
  const quiet = { now: SEEDED_AT, post: async () => ({ posted: true }) };
  const booked = await bookVisit(owner, { quoteId: approved.quoteId, memberIds: [crew.memberId], day: "2026-10-27", time: "09:00" }, quiet);
  await rescheduleVisit(owner, { visitId: booked.visit.visitId, time: "10:00" }, quiet);
  const timeOff = await addTimeOff(crew, { memberId: crew.memberId, day: "2026-10-28", reason: "Off" }, quiet);
  // A photo of that work, added by the crew.
  const workPhoto = await addUploadedWorkPhoto(crew, { jobId: booked.visit.jobId, visitId: booked.visit.visitId }, { url: `file:///seed/after-${n}.png`, name: "after.png", mimeType: "image/png" });
  // The approved quote's invoice, sent and partly paid by hand, and the business's Stripe account with
  // one handled webhook event: INV-0001 and the same shapes in both businesses.
  const { invoice } = await createInvoice(owner, { quoteId: approved.quoteId }, quiet);
  await sendInvoice(owner, invoice.id, quiet);
  const { payment } = await recordPayment(owner, { invoiceId: invoice.id, amountCents: 500, method: "cash" }, quiet);
  const stripeAccountId = `acct_fake_${n}`;
  await db().insert(schema.stripeAccounts).values({ orgId, accountId: stripeAccountId, status: "active", chargesEnabled: true, detailsSubmitted: true });
  await db().insert(schema.stripeEvents).values({ eventId: `evt_seed_${n}`, orgId, type: "account.updated", outcome: "account:active" });
  // An admitted text turn, its model call's receipt, and the business's own limits: the same keys,
  // session and response ids in both businesses.
  const admitted = await admitTurn({ orgId, memberId: owner.memberId, channel: "text", key: "text:seed", eveSessionId: `ses_${n}`, now: SEEDED_AT });
  assert.ok(admitted.ok);
  await recordUsage(
    { auth: { ...ownerAuth, attributes: { ...ownerAuth.attributes, reservationId: admitted.reservationId } }, eveSessionId: `ses_${n}`, turnId: "turn_seed", stepIndex: 0 },
    { kind: "step", inputTokens: 1000 * n, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 * n, reasoningTokens: 10, responseId: "resp_seed", responseModel: null },
    { now: SEEDED_AT },
  );
  await setUsageLimits(orgId, { hourlyTurns: 10 * n }, "seed");
  // The business's own invoice page, version 1 in both businesses, published.
  await saveVersion(owner, "invoice", invoicePage(`color${n}`), "seed");
  await publishVersion(owner, "invoice", 1);
  // The owner's conversation with the page designer about it: the same subject in both businesses.
  await ensureAgentSession(owner, "designer", "invoice", async () => `ses_design_${n}`);

  const detail = await getQuote(orgId, draft.quoteId);
  // The owner's admitted turn, traced: the same session and turn ids in both businesses.
  await db().insert(schema.turnTraces).values({
    id: `trc_seed_${n}`,
    orgId,
    memberId: owner.memberId,
    eveSessionId: `ses_${n}`,
    turnId: "turn_seed",
    source: "text",
    modelId: "muse-wonder-1.0",
    status: "completed",
    steps: [],
    startedAt: SEEDED_AT,
    finishedAt: SEEDED_AT,
  });
  // The draft quote's photo, priced: the same source and output names in both businesses.
  await db().insert(schema.pricedPhotos).values({
    id: `ppho_seed_${n}`,
    orgId,
    quoteId: draft.quoteId,
    revisionNumber: 1,
    sourceKind: "quote_attachment",
    sourceId: detail!.attachments[0].id,
    sourceUrl: detail!.attachments[0].url,
    url: `fake://priced/seed-${n}.png`,
    width: 1024,
    height: 1024,
    regions: [],
    memberId: owner.memberId,
  });
  // A forwarding address the crew member asked for, waiting on its code.
  await startClaim({ orgId, memberId: crew.memberId, address: `crew${n}@example.test`, setByMemberId: crew.memberId });
  return {
    orgId,
    owner,
    crew,
    ownerPhone,
    crewPhone,
    ownerPhoneId: ownerPhoneRow.id,
    crewPhoneId: crewPhoneRow.id,
    widget,
    gadget,
    rule,
    customer,
    property,
    businessNote,
    siteNote,
    draft,
    approved,
    crewDraft,
    attachmentId: detail!.attachments[0].id,
    visitId: booked.visit.visitId,
    serviceJobId: booked.visit.jobId,
    timeOffId: timeOff.id,
    workPhotoId: workPhoto.id,
    invoiceId: invoice.id,
    paymentId: payment.id,
    stripeAccountId,
  };
}

async function seedTwo() {
  const a = await seedBusiness(1, "America/New_York");
  const b = await seedBusiness(2, "America/Los_Angeles", true);
  return { a, b };
}

const businessTables = (Object.values(schema) as unknown[]).filter(
  (value): value is PgTable => is(value, PgTable) && "orgId" in getTableColumns(value as PgTable),
);

/** Every row business A has, in every table, as JSON: compared before and after B's turn. */
async function snapshot(orgId: string): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const table of businessTables) {
    const name = getTableName(table);
    out[name] = await db().execute(sql`select * from ${sql.identifier(name)} where org_id = ${orgId} order by 1`);
  }
  return JSON.stringify(out);
}

const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

withTestDb("every business table has org_id, and the seed fills each one for both businesses", async () => {
  const { a, b } = await seedTwo();
  assert.equal(businessTables.length, 44);
  for (const table of businessTables) {
    const name = getTableName(table);
    for (const orgId of [a.orgId, b.orgId]) {
      const rows = await db().execute(sql`select 1 from ${sql.identifier(name)} where org_id = ${orgId} limit 1`);
      assert.equal(rows.length, 1, `${name} has a row for ${orgId}`);
    }
  }
});

withTestDb("reads from business B return only business B's rows", async () => {
  const { a, b } = await seedTwo();
  const B = b.orgId;

  // Usage: B's receipts, reservations, and limits only.
  const usage = await monthlyUsage(B, { timeZone: "America/Los_Angeles", month: "2026-10", now: SEEDED_AT });
  assert.equal(usage.totals.outputTokens, 200);
  assert.equal(usage.totals.inputTokens, 2000);
  assert.deepEqual(usage.byMember.map((m) => m.memberId), [b.owner.memberId]);
  assert.equal((await usageNow(B, SEEDED_AT)).window.turns, 1);
  assert.equal((await limitsFor(B)).limits.hourlyTurns, 20);
  assert.equal((await limitsFor(a.orgId)).limits.hourlyTurns, 10);

  // Glossary and translations: B's own, though both glossaries say the same thing.
  assert.deepEqual(await listGlossary(B), [{ term: "widget", spanish: "artilugio", note: "" }]);
  setTranslatorForTests(async () => assert.fail("B's text is in B's cache"));
  const [cached] = await translateTexts({ orgId: B, memberId: b.owner.memberId, conversationId: "conv_none", target: "es", texts: ["Quote for 100 Example St"] });
  assert.deepEqual(cached, { text: "Cotización 2", sourceLanguage: "en", translated: true });

  const activity = await activityFor(B);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].memberId, b.owner.memberId);
  assert.equal((await activityFor(B, { memberId: a.owner.memberId })).length, 0);

  assert.equal((await getProfile(B)).name, "Example Services 2");
  assert.equal((await getProfile(B)).timeZone, "America/Los_Angeles");
  assert.deepEqual(idsOf(await listItems(B, { includeRetired: true })), idsOf([b.widget, b.gadget]));
  assert.equal((await findItemByName(B, "Widget service"))?.id, b.widget.id);
  assert.deepEqual(idsOf(await listRules(B, { includeRetired: true, includeSuggested: true })), [b.rule.id]);
  assert.deepEqual(await versions(B), { pricebookVersion: 2, rulesVersion: 1 });

  assert.deepEqual(idsOf(await searchCustomers(B, "Jane")), [b.customer.id]);
  assert.deepEqual(idsOf(await searchCustomers(B, "100 Example")), [b.customer.id]);
  assert.deepEqual(await searchCustomers(B, a.customer.phones[0]), []);
  assert.deepEqual(await searchCustomers(B, "jane1@example.test"), []);
  assert.equal(await getCustomer(B, a.customer.id), null);
  assert.deepEqual((await getCustomer(B, b.customer.id))?.properties.map((p) => p.id), [b.property.id]);
  assert.deepEqual((await getCustomer(B, b.customer.id))?.contacts.map((c) => c.customerId), [b.customer.id]);
  assert.deepEqual(await customerHistory(B, a.customer.id), []);
  assert.ok((await customerHistory(B, b.customer.id)).length > 0);

  // Notes and the record search: B's only, under the same words.
  assert.equal(await getNote(b.owner, a.siteNote.id), null);
  assert.deepEqual(idsOf(await listNotes(b.owner)), idsOf([b.businessNote, b.siteNote]));
  assert.deepEqual(idsOf(await listNotes(b.owner, { customerId: a.customer.id })), []);
  for (const query of ["gate code", "Jane Sample", "100 Example St", "sills", "1111", "INV-0001"]) {
    const { results } = await searchRecords(b.owner, query);
    assert.ok(results.length > 0 || query === "1111", `B finds its own ${query}`);
    const aIds = [a.siteNote.id, a.businessNote.id, a.customer.id, a.draft.quoteId, a.approved.quoteId, a.crewDraft.quoteId, a.invoiceId];
    assert.ok(results.every((r) => !aIds.includes(r.id)), `no A rows for ${query}`);
  }
  assert.deepEqual((await searchRecords(b.owner, "1111")).results, []);

  const bQuotes = [b.draft.quoteId, b.approved.quoteId, b.crewDraft.quoteId];
  const listed = (await listQuotes(B, { limit: 50 })).map((q) => q.quoteId);
  assert.equal(listed.length, 4);
  for (const id of bQuotes) assert.ok(listed.includes(id));
  for (const id of [a.draft.quoteId, a.approved.quoteId, a.crewDraft.quoteId]) assert.ok(!listed.includes(id));
  assert.ok((await listQuotes(B, { query: "Example St" })).every((q) => bQuotes.includes(q.quoteId)));
  assert.ok((await listQuotes(B, { query: "Jane" })).every((q) => bQuotes.includes(q.quoteId)));
  assert.equal(await getQuote(B, a.draft.quoteId), null);
  await assert.rejects(loadSummary(B, a.draft.quoteId), /QUOTE_NOT_FOUND/);
  await assert.rejects(renderCurrentPdf(B, a.draft.quoteId), /QUOTE_NOT_FOUND/);
  const detail = await getQuote(B, b.draft.quoteId);
  assert.deepEqual(detail?.attachments.map((x) => x.id), [b.attachmentId]);
  assert.equal(detail?.customer?.id, b.customer.id);
  assert.equal(await revisionNumberAt(B, a.draft.quoteId, new Date()), null);

  assert.deepEqual(idsOf(await listMembers(B)), [b.owner.memberId, b.crew.memberId].sort());
  assert.deepEqual(idsOf(await privilegedMembers(B)), [b.owner.memberId]);
  assert.equal(await findMemberById(B, a.owner.memberId), null);

  // B's owner waits on B's crew draft (B's prices: 4 x $20 = $80, minimum $20), never A's.
  const pending = await pendingForMember(b.owner, { now: SEEDED_AT });
  assert.ok(pending.some((line) => line.includes("Sam Crew 2") && line.includes("$80")), pending.join("; "));
  assert.ok(pending.every((line) => !line.includes("Sam Crew 1")), pending.join("; "));
  assert.deepEqual(await pendingForMember(b.crew, { now: SEEDED_AT }), ["100 Example St: waiting on the owner"]);

  // A's member, asked about through B, has nothing.
  assert.equal(await latestInbound(B, a.owner.memberId, ["user", "reaction"], new Date()), null);
  assert.equal(await lastProactiveFor(B, a.owner.memberId, new Date(0)), null);
  assert.equal((await lastProactiveFor(B, b.owner.memberId, new Date(0)))?.text, "Business 2 checking in");
  assert.equal(await askedApproval(B, a.owner.memberId, null), null);
  assert.equal((await askedApproval(B, b.owner.memberId, null))?.quoteId, b.draft.quoteId);
  assert.equal(await recentQuoteRef(B, a.owner.memberId, new Date(0)), null);
  assert.equal(await turnQuoteRef(B, a.owner.memberId, new Date(0)), null);

  const due = await dueNudges(B, new Date("2026-12-01T00:00:00Z"));
  assert.deepEqual(due.map((d) => d.quote.quoteId), [b.approved.quoteId]);

  // The schedule: B sees its own visit, job, and time off, at the same day and time as A's.
  const week = await readSchedule(b.owner, { from: "2026-10-26", days: 7 }, { now: SEEDED_AT });
  assert.deepEqual(week.visits.map((v) => v.visitId), [b.visitId]);
  assert.deepEqual(week.timeOff.map((t) => t.id), [b.timeOffId]);
  assert.deepEqual(idsOf(week.crew.map((c) => ({ id: c.memberId }))), [b.owner.memberId, b.crew.memberId].sort());
  assert.deepEqual((await readSchedule(b.crew, { from: "2026-10-26", days: 7 }, { now: SEEDED_AT })).visits.map((v) => v.visitId), [b.visitId]);
  assert.equal(await getVisit(b.owner, a.visitId), null);
  assert.equal(await getServiceJob(b.owner, a.serviceJobId), null);
  assert.deepEqual(await serviceJobsAbout(b.owner, { quoteId: a.approved.quoteId }), []);
  assert.deepEqual(await serviceJobsAbout(b.owner, { customerId: a.customer.id }), []);
  assert.deepEqual((await serviceJobsAbout(b.owner, { customerId: b.customer.id })).map((j) => j.id), [b.serviceJobId]);
  assert.ok((await toSchedule(B)).every((w) => (w.kind === "quote" ? w.quoteId : w.jobId) !== a.serviceJobId));
  await assert.rejects(findAvailability(b.owner, { memberIds: [a.crew.memberId], from: "2026-10-27" }, { now: SEEDED_AT }), /MEMBER_NOT_FOUND/);
  // Invoices and payments: the same number, INV-0001, is B's own in B.
  assert.deepEqual((await listInvoices(B)).map((i) => i.id), [b.invoiceId]);
  assert.deepEqual((await listInvoices(B, { query: "Jane" })).map((i) => i.id), [b.invoiceId]);
  assert.equal(await getInvoice(B, a.invoiceId), null);
  assert.equal(await resolveInvoiceId(B, "INV-0001"), b.invoiceId);
  assert.equal(await resolveInvoiceId(B, a.invoiceId), null);
  assert.deepEqual((await listPayments(B)).map((p) => p.id), [b.paymentId]);
  assert.deepEqual((await balancesByCustomer(B)).map((x) => x.customerId), [b.customer.id]);
  assert.equal((await invoiceTotals(B)).counts.all, 1);
  assert.equal(await invoiceForQuote(B, a.approved.quoteId), null);
  assert.equal((await invoicesForJobs(B, [a.serviceJobId, b.serviceJobId])).size, 1);
  assert.ok((await readyToInvoice(B)).every((r) => r.jobId !== a.serviceJobId));

  // B's crew are busy only with B's own visit, at 10 like A's.
  const free = (await findAvailability(b.owner, { memberIds: [b.crew.memberId], from: "2026-10-27", days: 1 }, { now: SEEDED_AT })).slots.map((slot) => slot.start);
  assert.ok(free.includes("09:00") && !free.includes("10:00") && free.includes("11:00"), free.join(" "));
});

withTestDb("writes from business B can't change business A's rows", async () => {
  install();
  const { a, b } = await seedTwo();
  const B = b.orgId;
  const before = await snapshot(a.orgId);

  // Pricebook and rules: A's ids are unknown in B; B's saves under the same names stay B's.
  await assert.rejects(updateItem(B, a.widget.id, { priceCents: 1 }, b.owner.memberId), /ITEM_NOT_FOUND/);
  await assert.rejects(retireRule(B, a.rule.id, b.owner.memberId), /RULE_NOT_FOUND/);
  const [resaved] = await saveItems(B, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 2500 }], b.owner.memberId);
  assert.equal(resaved.id, b.widget.id);
  await updateItem(B, b.widget.id, { name: "Gadget fitting" }, b.owner.memberId).then(
    () => assert.fail("renamed onto B's own gadget"),
    (error: Error) => assert.match(error.message, /NAME_TAKEN/),
  );
  await saveRule(B, { text: "No work above the third floor", kind: "exclusion" }, b.owner.memberId);
  await bumpVersion(B, "rules");
  await updateProfile(B, { name: "Example Services Two", taxRateBp: 700 }, b.owner.memberId);

  // Customers.
  await assert.rejects(saveCustomer(B, { customerId: a.customer.id, notes: "x" }, b.owner.memberId), /CUSTOMER_NOT_FOUND/);
  await saveCustomer(B, { name: "Jane Sample", address: "100 Example St" }, b.owner.memberId);
  await assert.rejects(saveContact(B, { customerId: a.customer.id, name: "X" }, b.owner.memberId), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(
    saveContact(B, { customerId: b.customer.id, contactId: a.customer.contacts[0].id, addPhones: ["+15555550123"] }, b.owner.memberId),
    /CONTACT_NOT_FOUND/,
  );
  await assert.rejects(removeContact(B, { customerId: b.customer.id, contactId: a.customer.contacts[0].id }, b.owner.memberId), /CONTACT_NOT_FOUND/);
  await assert.rejects(archiveCustomer(B, a.customer.id, b.owner.memberId), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(mergeCustomers(B, { keepId: b.customer.id, mergeId: a.customer.id }, b.owner.memberId), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(mergeCustomers(B, { keepId: a.customer.id, mergeId: b.customer.id }, b.owner.memberId), /CUSTOMER_NOT_FOUND/);
  // Notes: A's notes and A's customers, properties, and quotes are unknown to B.
  await assert.rejects(saveNote(b.owner, { noteId: a.siteNote.id, body: "x" }), /NOTE_NOT_FOUND/);
  await assert.rejects(saveNote(b.owner, { title: "x", customerId: a.customer.id }), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(saveNote(b.owner, { title: "x", propertyId: a.property.id }), /PROPERTY_NOT_FOUND/);
  await assert.rejects(saveNote(b.owner, { title: "x", quoteId: a.draft.quoteId }), /QUOTE_NOT_FOUND/);
  await saveNote(b.owner, { noteId: b.siteNote.id, body: "Gate code 9999" });

  // Quotes: A's items, rules, customers, properties, and quotes are all unknown to B.
  const line = { itemId: b.widget.id, quantity: 1 };
  await assert.rejects(createQuote({ title: "X", lines: [{ itemId: a.widget.id, quantity: 1 }] }, b.owner, { post }), /UNKNOWN_ITEM/);
  await assert.rejects(createQuote({ title: "X", lines: [line], ruleIds: [a.rule.id] }, b.owner, { post }), /UNKNOWN_RULE/);
  await assert.rejects(createQuote({ title: "X", lines: [line], customerId: a.customer.id }, b.owner, { post }), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(createQuote({ title: "X", lines: [line], propertyId: a.property.id }, b.owner, { post }), /PROPERTY_NOT_FOUND/);
  await assert.rejects(reviseQuote({ quoteId: a.draft.quoteId, lines: [line] }, b.owner, { post }), /QUOTE_NOT_FOUND/);
  await assert.rejects(
    reviseQuote({ quoteId: b.draft.quoteId, removePhotoIds: [a.attachmentId] }, b.owner, { post }),
    /PHOTO_NOT_FOUND/,
  );
  await assert.rejects(approveQuote(a.draft.quoteId, b.owner, { post }), /QUOTE_NOT_FOUND/);
  await assert.rejects(approveQuote(a.draft.quoteId, b.owner, { post, asked: null }), /QUOTE_NOT_FOUND/);
  const noId = await approveQuote(undefined, b.owner, { post, now: SEEDED_AT });
  assert.equal(noId.ok, false);
  if (!noId.ok && "candidates" in noId) {
    assert.ok(noId.candidates.length > 0);
    assert.ok(noId.candidates.every((q) => q.quoteId !== a.draft.quoteId && q.quoteId !== a.crewDraft.quoteId));
  }
  await assert.rejects(requestOwnerApproval(a.crewDraft.quoteId, b.crew, { post }), /QUOTE_NOT_FOUND/);
  await assert.rejects(setQuoteOutcome(a.approved.quoteId, "won", b.owner, { post }), /QUOTE_NOT_FOUND/);
  await assert.rejects(setQuoteOutcome(a.draft.quoteId, "sent", b.owner, { post }), /QUOTE_NOT_FOUND/);
  await assert.rejects(setFollowup(a.approved.quoteId, 5, b.owner), /QUOTE_NOT_FOUND/);
  await assert.rejects(emailQuote({ quoteId: a.approved.quoteId, to: "x@example.test" }, b.owner, { post }), /QUOTE_NOT_FOUND/);
  await assert.rejects(linkRecentAttachments(B, a.draft.quoteId, b.owner.memberId, new Date(0)), /QUOTE_NOT_FOUND/);
  assert.equal(await linkRecentAttachments(B, b.approved.quoteId, a.owner.memberId, new Date(0)), 0);
  assert.equal(await setAsideRecentAttachments(B, a.owner.memberId, { windowMs: Date.now() }), 0);
  assert.equal(await cancelFollowups(B, a.approved.quoteId), 0);
  assert.equal(await cancelNotices(B, a.draft.quoteId), 0);

  // B's own quote work, start to finish, while A's rows sit under the same names.
  posts.length = 0;
  const bQuote = await reviseQuote({ quoteId: b.crewDraft.quoteId, lines: [line] }, b.owner, { post, now: SEEDED_AT });
  assert.equal(bQuote.totalCents, 2675, "B's new widget price and B's new 7% tax");
  const notified = await requestOwnerApproval(b.draft.quoteId, b.crew, { post, now: SEEDED_AT });
  assert.deepEqual(notified, { notified: ["Pat Example"], queued: [] });
  await approveQuote(b.draft.quoteId, b.owner, { post, now: SEEDED_AT });
  await setQuoteOutcome(b.draft.quoteId, "sent", b.owner, { post, now: SEEDED_AT });
  await setFollowup(b.draft.quoteId, 5, b.owner, { now: SEEDED_AT });
  await setQuoteOutcome(b.approved.quoteId, "won", b.owner, { post, now: SEEDED_AT });
  await emailQuote({ quoteId: b.draft.quoteId, to: "jane2@example.test" }, b.owner, { post, now: SEEDED_AT });
  assert.ok(posts.length > 0);
  assert.ok(posts.every((p) => p.orgId === B && [b.owner.memberId, b.crew.memberId].includes(p.memberId)));

  // Members and phones: A's members and phones are out of reach.
  await assert.rejects(removeMember(B, a.crew.memberId), /MEMBER_NOT_FOUND/);
  await assert.rejects(setMemberRole(B, a.crew.memberId, "admin"), /MEMBER_NOT_FOUND/);
  await assert.rejects(
    reactivateMember(B, a.crew.memberId, a.crewPhone, { name: "X", role: "member", addedByMemberId: b.owner.memberId }),
    /PHONE_NOT_FOUND/,
  );
  await assert.rejects(addPhone(B, b.crew.memberId, a.crewPhone), /PHONE_IN_USE/);
  await assert.rejects(addPhone(B, a.crew.memberId, "+15555550199"), /MEMBER_NOT_FOUND/);
  await setPhoneStatus(B, a.ownerPhoneId, "stopped");
  await setPhonePhoton(B, a.ownerPhoneId, { photonUserId: "pu_x", assignedLine: "+15555550000" });
  assert.deepEqual(await recordInbound(B, a.crewPhoneId, "thread:x", new Date()), { verified: false });
  await upsertThread(B, b.owner.memberId, "ses_b2");
  await assert.rejects(upsertThread(B, a.owner.memberId, "ses_x"), /MEMBER_NOT_FOUND/);
  assert.equal(await memberConversationForSession(B, a.owner.memberId, "ses_1"), null);
  assert.equal(await memberConversationForSession(B, b.owner.memberId, "ses_1"), null);
  // Jobs: B drives only its own; A's job and A's quote are out of reach.
  setJobRunnerForTests({
    createSession: async (claims) => {
      assert.equal(claims.orgId, B);
      return "ses_job_b";
    },
    send: async () => ({ status: "replied", reply: "ok" }),
  });
  try {
    await assert.rejects(runJobTurn(b.owner, "job_1", "hi", { operationId: "op_x" }), /JOB_NOT_FOUND/);
    await assert.rejects(setJobStatus(b.owner, "job_1", "done"), /JOB_NOT_FOUND/);
    const bThread = (await memberConversationForSession(B, b.owner.memberId, "ses_b2"))!;
    await assert.rejects(openJob(b.owner, { id: "job_x", thread: bThread, title: "x", quoteId: a.draft.quoteId }), /QUOTE_NOT_FOUND/);
    await assert.rejects(openJob(b.owner, { id: "job_x", thread: bThread, title: "x", customerId: a.customer.id }), /CUSTOMER_NOT_FOUND/);
    await runJobTurn(b.owner, "job_2", "hi", { operationId: "op_b" });
    await setJobStatus(b.owner, "job_2", "done");
  } finally {
    setJobRunnerForTests(null);
  }
  assert.equal(await getOwnJob(B, a.owner.memberId, "job_1"), null);
  assert.deepEqual(await listJobs(B, a.owner.memberId), []);
  assert.deepEqual(await jobsAbout(b.owner, { quoteId: a.draft.quoteId }), []);
  const newCrew = await createMember({ orgId: B, name: "Pat Example", role: "member" });
  await addPhone(B, newCrew.id, "+15555550199");
  await removeMember(B, newCrew.id);

  // Outbound: B can't text A's people, and B's owner notice reaches only B's owners.
  assert.deepEqual(await postToMember(B, a.owner.memberId, { text: "hi" }, "system"), {
    posted: false,
    reason: "no_verified_phone",
  });
  assert.equal(sent.length, 0);
  const owners = await notifyOwners(B, "B's owners only", "system");
  assert.deepEqual(owners, { notified: ["Pat Example"], queued: [] });
  assert.deepEqual(sent.map((s) => s.threadId), [thread(b.ownerPhone)]);

  // Events: the same key is separate per business.
  assert.deepEqual(await recordEvent({ orgId: B, kind: "morning", key: "morning:shared:2026-10-19" }), { inserted: false });
  assert.deepEqual(await recordEvent({ orgId: B, kind: "morning", key: "morning:shared:2026-10-20" }), { inserted: true });

  // Sign-in codes: A's code doesn't sign in B's owner, and B's sign-in leaves A's code alone.
  assert.equal((await verifyLoginCode(b.ownerPhone, "000001")).ok, false);
  const signedIn = await verifyLoginCode(b.ownerPhone, "000002");
  assert.equal(signedIn.ok && signedIn.member.orgId, B);

  // The schedule: A's visits, work, time off, crew, and quotes are unknown in B.
  const quiet = { now: SEEDED_AT, post };
  await assert.rejects(rescheduleVisit(b.owner, { visitId: a.visitId, time: "11:00" }, quiet), /VISIT_NOT_FOUND/);
  await assert.rejects(changeVisitStatus(b.owner, { visitId: a.visitId, status: "cancelled" }, quiet), /VISIT_NOT_FOUND/);
  await assert.rejects(closeServiceJob(b.owner, { jobId: a.serviceJobId, status: "cancelled", cancelUpcomingVisits: true }, quiet), /SERVICE_JOB_NOT_FOUND/);
  await assert.rejects(bookVisit(b.owner, { jobId: a.serviceJobId, memberIds: [b.crew.memberId], day: "2026-10-29", time: "09:00" }, quiet), /SERVICE_JOB_NOT_FOUND/);
  // Customer pages: the same version number in both businesses, each its own design.
  assert.match((await publishedTemplate(B, "invoice")) ?? "", /color2/);
  assert.equal((await customerPageState(B, "invoice")).latest?.request, "seed");
  assert.match((await customerPageState(B, "invoice")).latest?.html ?? "", /color2/);
  // Work photos: B can't add to A's work or visit, take A's off, or read A's.
  await assert.rejects(addUploadedWorkPhoto(b.crew, { jobId: a.serviceJobId }, { url: "file:///x.png", name: "x.png", mimeType: "image/png" }), /SERVICE_JOB_NOT_FOUND/);
  await assert.rejects(attachTextedWorkPhotos(b.crew, { visitId: a.visitId }, SEEDED_AT), /VISIT_NOT_FOUND/);
  await assert.rejects(removeWorkPhoto(b.owner, a.serviceJobId, a.workPhotoId), /PHOTO_NOT_FOUND/);
  assert.equal(await workPhoto(b.owner.orgId, a.serviceJobId, a.workPhotoId), null);
  assert.deepEqual((await listWorkPhotos(b.owner.orgId, { jobId: a.serviceJobId })).length, 0);
  await assert.rejects(bookVisit(b.owner, { quoteId: a.approved.quoteId, memberIds: [b.crew.memberId], day: "2026-10-29", time: "09:00" }, quiet), /QUOTE_NOT_FOUND/);
  await assert.rejects(bookVisit(b.owner, { quoteId: b.approved.quoteId, memberIds: [a.crew.memberId], day: "2026-10-29", time: "09:00" }, quiet), /MEMBER_NOT_FOUND/);
  await assert.rejects(bookVisit(b.owner, { title: "Shed", customerId: a.customer.id, memberIds: [b.crew.memberId], day: "2026-10-29", time: "09:00" }, quiet), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(removeTimeOff(b.owner, a.timeOffId), /TIME_OFF_NOT_FOUND/);
  await assert.rejects(setWorkHours(b.owner, { memberId: a.crew.memberId, hours: null }, quiet), /MEMBER_NOT_FOUND/);
  await assert.rejects(addTimeOff(b.owner, { memberId: a.crew.memberId, day: "2026-10-29" }, quiet), /MEMBER_NOT_FOUND/);
  // B's own changes, with the same day and crew names as A's, stay B's.
  await bookVisit(b.owner, { quoteId: b.approved.quoteId, memberIds: [b.crew.memberId], day: "2026-10-27", time: "13:00" }, quiet);
  await setWorkHours(b.owner, { hours: [{ day: 1, start: "07:00", end: "15:00" }] }, quiet);
  await closeServiceJob(b.owner, { jobId: b.serviceJobId, status: "cancelled", cancelUpcomingVisits: true }, quiet);

  // Invoices: A's quotes, work, customers, items, invoices, and payments are unknown in B.
  await assert.rejects(createInvoice(b.owner, { quoteId: a.approved.quoteId }), /QUOTE_NOT_FOUND/);
  await assert.rejects(createInvoice(b.owner, { serviceJobId: a.serviceJobId }), /SERVICE_JOB_NOT_FOUND/);
  await assert.rejects(createInvoice(b.owner, { title: "X", customerId: a.customer.id, lines: [{ name: "X", quantity: 1, unitCents: 100 }] }), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(createInvoice(b.owner, { title: "X", lines: [{ itemId: a.widget.id, quantity: 1 }] }), /UNKNOWN_ITEM/);
  await assert.rejects(updateInvoice(b.owner, a.invoiceId, { notes: "x" }), /INVOICE_NOT_FOUND/);
  await assert.rejects(sendInvoice(b.owner, a.invoiceId, quiet), /INVOICE_NOT_FOUND/);
  await assert.rejects(recordPayment(b.owner, { invoiceId: a.invoiceId, amountCents: 100, method: "cash" }), /INVOICE_NOT_FOUND/);
  await assert.rejects(voidInvoice(b.owner, a.invoiceId), /INVOICE_NOT_FOUND/);
  await assert.rejects(removePayment(b.owner, a.paymentId), /PAYMENT_NOT_FOUND/);
  await assert.rejects(recordStripePayment(B, { invoiceId: a.invoiceId, amountCents: 100, checkoutSessionId: "cs_x", paymentIntentId: null }), /INVOICE_NOT_FOUND/);
  // A webhook from B's account can't pay A's invoice, whatever its metadata says.
  const session = (orgId: string, invoiceId: string, id: string) => ({
    id: `evt_${id}`,
    type: "checkout.session.completed",
    account: b.stripeAccountId,
    data: { object: { id: `cs_${id}`, amount_total: 100, currency: "usd", payment_status: "paid", metadata: { orgId, invoiceId } } },
  });
  assert.equal((await processStripeEvent(session(a.orgId, a.invoiceId, "mix1"))).outcome, "ignored:org_mismatch");
  assert.equal((await processStripeEvent(session(B, a.invoiceId, "mix2"))).outcome, "ignored:no_invoice");
  assert.equal((await processStripeEvent({ ...session(a.orgId, a.invoiceId, "mix3"), account: "acct_unknown" })).ignored, "unknown account");
  // B's own invoice work, with the same number and names as A's.
  await recordPayment(b.owner, { invoiceId: b.invoiceId, amountCents: 100, method: "check" }, quiet);
  assert.equal((await processStripeEvent(session(B, b.invoiceId, "b1"))).outcome, "payment");
  const bJob = await createInvoice(b.owner, { title: "100 Example St", customerId: b.customer.id, lines: [{ itemId: b.widget.id, quantity: 1 }] }, quiet);
  assert.equal(bJob.invoice.label, "INV-0002");
  await voidInvoice(b.owner, bJob.invoice.id);

  // B's glossary, changed every way, and a new translation, under A's words.
  await saveGlossaryTerm(b.owner, { term: "Widget", spanish: "aparato" });
  await removeGlossaryTerm(b.owner, "widget");
  await assert.rejects(removeGlossaryTerm(b.owner, "widget"), /GLOSSARY_TERM_NOT_FOUND/);
  await replaceGlossary(b.owner, [{ term: "widget", spanish: "artilugio" }, { term: "gadget", spanish: "chisme" }]);
  setTranslatorForTests(translatesAs("Hola"));
  await translateTexts({ orgId: B, memberId: b.owner.memberId, conversationId: "conv_none", target: "es", texts: ["Hello", "Quote for 100 Example St"] });

  assert.equal(await snapshot(a.orgId), before, "business A's rows are unchanged");
  assert.deepEqual(await listGlossary(a.orgId), [{ term: "widget", spanish: "artilugio", note: "" }]);
  assert.equal((await getProfile(a.orgId)).name, "Example Services 1");
  assert.equal((await findItemByName(a.orgId, "Widget service"))?.priceCents, 1000);
});

withTestDb("an inbound text finds its business by the sender's phone", async () => {
  const { a, b } = await seedTwo();
  const sends: Array<Parameters<DispatchDeps["send"]>> = [];
  const replies: string[] = [];
  const deps: DispatchDeps = {
    send: async (...args) => void sends.push(args),
    post: async (threadId, text) => (replies.push(`${threadId}: ${text}`), [`out_${replies.length}`]),
    markRead: async () => {},
    now: new Date(),
  };
  const inbound = (id: string, from: string) => ({
    id,
    threadId: thread(from),
    text: "20 widgets at 100 Example St",
    authorUserId: from,
    authorIsBot: false,
    attachments: [],
    service: "iMessage" as const,
    thread: { id: thread(from) },
  });

  await handleInbound(inbound("in_a", a.ownerPhone), deps);
  await handleInbound(inbound("in_b", b.crewPhone), deps);
  assert.deepEqual(
    sends.map(([, options]) => [options.auth.attributes.orgId, options.auth.attributes.memberId]),
    [
      [a.orgId, a.owner.memberId],
      [b.orgId, b.crew.memberId],
    ],
  );
  const rows = await db().select().from(schema.messages);
  assert.equal(rows.find((r) => r.providerMessageId === "in_a")?.orgId, a.orgId);
  assert.equal(rows.find((r) => r.providerMessageId === "in_b")?.orgId, b.orgId);
  // B's crew context names only B's work.
  assert.ok(sends[1][1].context.every((line) => !line.includes("Sam Crew 1")));

  // The webhook stores each delivery under its sender's business and member.
  const secret = "isolation-secret";
  for (const [id, from] of [["wh_a", a.crewPhone], ["wh_b", b.ownerPhone]] as const) {
    const body = JSON.stringify({ event: "messages", message: { id, direction: "inbound", sender: { id: from }, content: { type: "text", text: "hi" } }, space: { id: `iMessage;-;${from}` } });
    const request = new Request("http://x/eve/v1/photon", { method: "POST", body, headers: signPhotonWebhook(body, secret) });
    assert.ok((await intakePhotonWebhook(request, { secret, encodeThreadId: ({ chatGuid }) => `imessage:${chatGuid}` })).queued);
  }
  const stored = await db().select().from(schema.deliveries);
  assert.deepEqual(
    ["wh_a", "wh_b"].map((id) => { const row = stored.find((r) => r.providerMessageId === id); return [row?.orgId, row?.memberId]; }),
    [[a.orgId, a.crew.memberId], [b.orgId, b.owner.memberId]],
  );

  // A tapback from B's owner on A's message names no quote: A's message isn't B's to resolve.
  sends.length = 0;
  await handleReaction(
    {
      id: "rx_b",
      threadId: thread(b.ownerPhone),
      targetMessageId: `pm_out_1`,
      emojiName: "thumbs_up",
      glyph: "👍",
      authorUserId: b.ownerPhone,
      thread: { id: thread(b.ownerPhone) },
    },
    deps,
  );
  assert.equal(sends[0][0], "👍 (tapback)");
  assert.ok(sends[0][1].context.every((line) => !line.includes(a.draft.quoteId)));

  // A turn whose principal names one business and the phone of another member posts nothing.
  const real = memberAuth((await findMemberById(a.orgId, a.owner.memberId))!, (await findMemberByPhone(a.ownerPhone))!.phone);
  const mixed = { ...real, attributes: { ...real.attributes, orgId: b.orgId } };
  const state = {};
  const result = await handleAssistantMessage(
    { finishReason: "stop", message: "Done." },
    { state, threadId: thread(a.ownerPhone), auth: mixed },
    { post: deps.post, now: new Date() },
  );
  assert.deepEqual(result, { posted: false });
  assert.equal(
    await resolveCaller({ authenticator: "photon-imessage", principalId: "x", attributes: mixed.attributes }),
    null,
  );
});

// Tools: the business comes from the caller, never from the input.
type AnyTool = { inputSchema: unknown; execute: (input: never, ctx: never) => unknown };
type Out = Record<string, any>;
async function run(tool: AnyTool, input: unknown, caller: Caller): Promise<Out> {
  const ctx = {
    session: {
      auth: {
        current: {
          authenticator: "photon-imessage",
          principalId: `member:${caller.memberId}`,
          attributes: { orgId: caller.orgId, memberId: caller.memberId },
        },
      },
    },
  };
  return (await tool.execute((tool.inputSchema as z.ZodType).parse(input) as never, ctx as never)) as Out;
}

withTestDb("a forwarded email finds its business by the inbox, and its sender only among that business's members", async () => {
  const { a, b } = await seedTwo();
  const inboxA = await createBusinessInbox(a.orgId);
  const inboxB = await createBusinessInbox(b.orgId);
  // One person can be on two teams: the same address is each business's own member. The same email sent to
  // both inboxes is two deliveries.
  await confirmedEmailForTests(a.orgId, a.owner.memberId, "pat@example.com");
  await confirmedEmailForTests(b.orgId, b.owner.memberId, "pat@example.com");
  await confirmedEmailForTests(a.orgId, a.crew.memberId, "sam@example.com");
  const deliver = async (inbox: { inboxId: string; address: string }, from: string, messageId = "<same@mail.example.com>") => {
    const body = JSON.stringify(await fakeReceivedEvent({ inboxId: inbox.inboxId, to: inbox.address, from, subject: "Fwd: job", text: "20 widgets at 100 Example St", messageId }));
    const headers = signAgentMailWebhook(body, agentMailWebhookSecret()!);
    return intakeAgentMailWebhook(new Request("http://x/api/webhooks/agentmail", { method: "POST", body, headers }));
  };
  const toA = await deliver(inboxA, "pat@example.com");
  const toB = await deliver(inboxB, "Pat Example <pat@example.com>");
  assert.deepEqual([toA.queued?.orgId, toA.queued?.memberId], [a.orgId, a.owner.memberId]);
  assert.deepEqual([toB.queued?.orgId, toB.queued?.memberId], [b.orgId, b.owner.memberId]);
  // A's crew address means nothing to B's inbox: dropped and recorded in B, never routed to A.
  const stray = await deliver(inboxB, "sam@example.com", "<stray@mail.example.com>");
  assert.equal(stray.queued, undefined);
  const drops = await db().select().from(schema.events).where(sql`${schema.events.kind} = 'email.dropped'`);
  assert.deepEqual(drops.map((e) => [e.orgId, e.data.reason]), [[b.orgId, "unknown_sender"]]);

  // B's email runs in a thread of B's owner's, as B's owner, and never reaches A's. (The seed's own texts are set aside.)
  await db().update(schema.deliveries).set({ status: "done" }).where(sql`${schema.deliveries.kind} <> 'email'`);
  const started: JobClaims[] = [];
  setJobRunnerForTests({
    createSession: async (claims) => `ses_email_${claims.conversationId}`,
    send: async () => ({ status: "replied", reply: null }),
    start: async (claims) => void started.push(claims),
  });
  const sends: Array<{ threadId: string; attributes: Record<string, unknown> }> = [];
  const handler = photonDeliveryHandler({
    send: async (target, _content, options) => void sends.push({ threadId: target.id, attributes: options.auth.attributes }),
    post: async () => ["out_1"],
    markRead: async () => {},
    parse: () => {
      throw new Error("not a Photon payload");
    },
    thread: (id) => ({ id, toJSON: () => ({ id }) }),
    sleep: async () => {},
  });
  assert.equal(await processMember(b.orgId, b.owner.memberId, handler), 1);
  setJobRunnerForTests(null);
  assert.equal(sends.length, 0, "not the main conversation");
  assert.deepEqual(started.map((c) => [c.orgId, c.memberId, c.origin]), [[b.orgId, b.owner.memberId, "email"]]);
  const [emailThread] = await db().select().from(schema.conversations).where(sql`${schema.conversations.id} = ${started[0].conversationId}`);
  assert.deepEqual([emailThread.orgId, emailThread.memberId, emailThread.source], [b.orgId, b.owner.memberId, "email"]);
  const logged = await db().select().from(schema.messages).where(sql`${schema.messages.providerMessageId} like 'agentmail:%'`);
  assert.deepEqual(logged.map((m) => [m.orgId, m.memberId]), [[b.orgId, b.owner.memberId]]);
});

withTestDb("tools run in the caller's business", async () => {
  install();
  const { a, b } = await seedTwo();
  const business = await run(readBusinessTool, {}, b.owner);
  assert.equal(business.profile.name, "Example Services 2");
  assert.deepEqual(business.you, { memberId: b.owner.memberId, name: b.owner.name, role: "owner" });
  assert.deepEqual(business.items.map((i: Out) => i.id).sort(), idsOf([b.widget, b.gadget]));
  assert.deepEqual(business.rules.map((r: Out) => r.id), [b.rule.id]);
  assert.deepEqual(business.members.map((m: Out) => m.id).sort(), [b.owner.memberId, b.crew.memberId].sort());

  assert.deepEqual(business.notes.map((n: Out) => n.noteId), [b.businessNote.id]);
  assert.deepEqual(business.glossary, [{ term: "widget", spanish: "artilugio", note: "" }]);
  const glossary = await run(saveGlossaryTermTool, { term: "gadget", spanish: "chisme" }, b.owner);
  assert.deepEqual(glossary.glossary.map((t: Out) => t.term), ["gadget", "widget"]);
  assert.deepEqual((await listGlossary(a.orgId)).map((t) => t.term), ["widget"]);
  const searched = await run(searchRecordsTool, { query: "gate code" }, b.owner);
  assert.deepEqual(searched.results.map((r: Out) => r.id), [b.siteNote.id]);
  assert.match((await run(readNoteTool, { noteId: a.siteNote.id }, b.owner)).error, /NOTE_NOT_FOUND/);
  assert.equal((await run(readNoteTool, { noteId: b.siteNote.id }, b.owner)).note.text, "Gate code 2222");
  assert.match((await run(saveNoteTool, { title: "x", customerId: a.customer.id }, b.owner)).error, /CUSTOMER_NOT_FOUND/);
  assert.match((await run(mergeCustomersTool, { keepCustomerId: b.customer.id, mergeCustomerId: a.customer.id }, b.owner)).error, /CUSTOMER_NOT_FOUND/);
  const found = await run(findCustomerTool, { query: "Jane Sample" }, b.owner);
  assert.deepEqual(found.customers.map((c: Out) => c.id), [b.customer.id]);
  const listed = await run(listQuotesTool, { query: "Example" }, b.owner);
  assert.ok(listed.quotes.length > 0);
  assert.ok(listed.quotes.every((q: Out) => q.quoteId !== a.draft.quoteId && q.quoteId !== a.crewDraft.quoteId));
  assert.match((await run(getQuoteTool, { quoteId: a.draft.quoteId }, b.owner)).error, /QUOTE_NOT_FOUND/);

  const schedule = await run(readScheduleTool, { day: "2026-10-26", days: 7 }, b.owner);
  assert.deepEqual(schedule.visits.map((v: Out) => v.visitId), [b.visitId]);
  assert.match(
    (await run(bookVisitTool, { quoteId: a.approved.quoteId, memberIds: [b.crew.memberId], day: "2026-10-29", time: "09:00" }, b.owner)).error,
    /QUOTE_NOT_FOUND/,
  );

  const invoices = await run(listInvoicesTool, {}, b.owner);
  assert.deepEqual(invoices.invoices.map((i: Out) => i.invoiceId), [b.invoiceId]);
  assert.match((await run(getInvoiceTool, { invoiceId: a.invoiceId }, b.owner)).error, /INVOICE_NOT_FOUND/);
  assert.equal((await run(getInvoiceTool, { invoiceId: "INV-0001" }, b.owner)).invoice.invoiceId, b.invoiceId);
  assert.match((await run(recordPaymentTool, { invoiceId: a.invoiceId, amountCents: 100, method: "cash" }, b.owner)).error, /INVOICE_NOT_FOUND/);
  // Crew never see business-wide money.
  assert.match((await run(listInvoicesTool, {}, b.crew)).error, /NOT_PRIVILEGED/);

  // Adding A's crew phone to B is refused: a phone belongs to one business.
  const added = await run(addMemberTool, { name: "Sam", phone: a.crewPhone }, b.owner);
  assert.match(added.error, /PHONE_IN_USE/);
  assert.equal((await findMemberByPhone(a.crewPhone))?.member.orgId, a.orgId);
  assert.equal((await listMembers(b.orgId)).length, 2);
});

withTestDb("the hourly tick runs each business in its own time zone and quiet hours", async () => {
  install();
  const { a, b } = await seedTwo();
  const sentTo = (phone: string) => sent.filter((s) => s.threadId === thread(phone)).map((s) => s.text);

  // 08:00 in New York, 05:00 in Los Angeles (quiet until 07:00). Nudges came due on the 23rd.
  // Each business's invoice, due on the 20th, is past due long enough for its owner's nudge too.
  const early = await runHourlyTick(new Date("2026-10-24T12:00:00Z"));
  assert.deepEqual(early, { nudges: 2, mornings: 2, notices: 1 });
  assert.ok(sentTo(a.ownerPhone).some((t) => t.startsWith("Unpaid and past due: INV-0001 Jane Sample $35 (4 days late)")));
  assert.ok(sentTo(a.ownerPhone).some((t) => t === "Notice 1"));
  assert.ok(sentTo(a.ownerPhone).some((t) => t.startsWith("200 Sample Ave ($40) was approved")));
  assert.ok(sentTo(a.ownerPhone).includes(
    "Good morning. 1 quote waiting on customers, 1 crew draft waiting on you, 1 draft in progress, 1 invoice overdue ($35).",
  ));
  assert.ok(sentTo(a.crewPhone).some((t) => t.startsWith("Good morning.")));
  assert.deepEqual([...sentTo(b.ownerPhone), ...sentTo(b.crewPhone)], []);

  // 11:00 in New York, 08:00 in Los Angeles: business B's turn, and nothing new for A.
  sent = [];
  const later = await runHourlyTick(new Date("2026-10-24T15:00:00Z"));
  assert.deepEqual(later, { nudges: 2, mornings: 2, notices: 1 });
  assert.ok(sentTo(b.ownerPhone).some((t) => t.startsWith("Unpaid and past due: INV-0001 Jane Sample $75 (4 days late)")));
  assert.deepEqual([...sentTo(a.ownerPhone), ...sentTo(a.crewPhone)], []);
  assert.ok(sentTo(b.ownerPhone).includes("Notice 2"));
  assert.ok(sentTo(b.ownerPhone).some((t) => t.startsWith("200 Sample Ave ($80) was approved")));
  assert.ok(sentTo(b.ownerPhone).includes(
    "Good morning. 1 quote waiting on customers, 1 crew draft waiting on you, 2 drafts in progress, 1 invoice overdue ($75).",
  ));
  assert.ok(sentTo(b.crewPhone).some((t) => t.startsWith("Good morning.")));

  // Each business's bookkeeping names only its own members.
  for (const [org, others] of [
    [a.orgId, [b.owner.memberId, b.crew.memberId]],
    [b.orgId, [a.owner.memberId, a.crew.memberId]],
  ] as const) {
    for (const table of [schema.events, schema.followups, schema.messages]) {
      const rows = await db().select({ memberId: table.memberId }).from(table).where(sql`${table.orgId} = ${org}`);
      assert.ok(rows.every((r) => !others.includes(r.memberId as string)), `${getTableName(table)} in ${org}`);
    }
  }
});

withTestDb("branding by text stays in the caller's business: logo, PDF look, and what read_business shows", async () => {
  install();
  const { a, b } = await seedTwo();
  const dir = await mkdtemp(`${tmpdir()}/gw-logo-`);
  try {
    // A's owner texts a logo; the channel stored it (here, a file) and logged the text.
    const file = `${dir}/logo.png`;
    const pixels = new Uint8Array(120 * 40 * 4).fill(180);
    await writeFile(file, new Uint8Array(UPNG.encode([pixels.buffer], 120, 40, 0)));
    await db().insert(schema.messages).values({
      id: "msg_logo_1",
      orgId: a.orgId,
      memberId: a.owner.memberId,
      phoneE164: a.owner.phoneE164!,
      direction: "inbound",
      kind: "user",
      body: "use this as our logo",
      attachments: [{ type: "image", url: pathToFileURL(file).href, mimeType: "image/png" }],
    });
    const before = await snapshot(a.orgId);

    // B's owner gets B's own seeded photo (a fake one, with no bytes), never A's readable logo; and B's
    // changes stay B's.
    assert.match((await run(setLogoTool, {}, b.owner)).error, /LOGO_UNREADABLE/);
    assert.match((await run(setLogoTool, {}, b.crew)).error, /NOT_PRIVILEGED/);
    assert.match((await run(updateBrandingTool, { invoiceFooter: "Sample terms B" }, b.crew)).error, /NOT_PRIVILEGED/);
    assert.deepEqual((await run(updateBrandingTool, { invoiceFooter: "Sample terms B", accentColor: "#123456" }, b.owner)).changed, [
      "pdfAccentColor",
      "invoiceFooter",
    ]);
    assert.deepEqual((await run(setLogoTool, { remove: true }, b.owner)), { removed: false });
    assert.equal(await snapshot(a.orgId), before, "nothing of A's changed");
    assert.equal((await getOrganization(a.orgId))?.logo, null);

    // A's crew can't set it; A's owner can, from their own text.
    assert.match((await run(setLogoTool, {}, a.crew)).error, /NOT_PRIVILEGED/);
    const set = await run(setLogoTool, {}, a.owner);
    assert.deepEqual(set, { logoSet: true, width: 120, height: 40 });
    assert.ok((await getOrganization(a.orgId))?.logo);
    assert.equal((await getOrganization(b.orgId))?.logo, null);
    const [message] = await db().select().from(schema.messages).where(eq(schema.messages.id, "msg_logo_1"));
    assert.equal(message.attachments[0].document, true, "the logo never attaches to a quote");

    const readA = await run(readBusinessTool, {}, a.owner);
    const readB = await run(readBusinessTool, {}, b.owner);
    assert.equal(readA.pdf.hasLogo, true);
    assert.equal(readA.pdf.invoiceFooter, null);
    assert.equal(readB.pdf.hasLogo, false);
    assert.equal(readB.pdf.invoiceFooter, "Sample terms B");
    assert.equal(readB.pdf.accentColor, "#123456");
    // A's PDFs still render, with A's look.
    assert.ok((await renderCurrentPdf(a.orgId, a.draft.quoteId)).bytes.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

withTestDb("deleting business B removes every row of it, its providers' records, and its own sign-ins, and leaves A alone", async () => {
  const { a, b } = await seedTwo();
  const STORED = "https://example123.public.blob.vercel-storage.com/logos/org_2-abc.png";
  const A_PDF = "https://example123.public.blob.vercel-storage.com/quotes/a/r1.pdf";
  const SHARED = "https://example123.public.blob.vercel-storage.com/inbound/shared.jpg";
  await db().update(schema.organization).set({ logo: STORED, inboxId: "inbox_b", inboxAddress: "b@agentmail.example" }).where(eq(schema.organization.id, b.orgId));
  // A's files must survive B's delete: A's PDF link pasted into B's note text, and a file both point to.
  await db().update(schema.organization).set({ logo: SHARED }).where(eq(schema.organization.id, a.orgId));
  await db().update(schema.notes).set({ body: `see ${A_PDF}` }).where(eq(schema.notes.orgId, b.orgId));
  await db().update(schema.messages).set({ attachments: [{ type: "image", url: SHARED, mimeType: "image/jpeg" }] }).where(eq(schema.messages.orgId, b.orgId));
  // B's owner has a sign-in of their own; a person in both businesses keeps theirs.
  await db().insert(schema.user).values([
    { id: "user_b_only", name: "Pat Example", email: "b-only@phone.example" },
    { id: "user_both", name: "Sam Both", email: "both@phone.example" },
    { id: "user_admin", name: "Admin", email: "admin@example.test", role: "super_admin" },
  ]);
  await db().insert(schema.session).values([
    { id: "s_b", token: "t_b", userId: "user_b_only", expiresAt: new Date(Date.now() + 3_600_000) },
    { id: "s_admin", token: "t_admin", userId: "user_admin", activeOrganizationId: b.orgId, expiresAt: new Date(Date.now() + 3_600_000) },
  ]);
  const ownerB = await findMemberById(b.orgId, b.owner.memberId);
  const crewB = await findMemberById(b.orgId, b.crew.memberId);
  const crewA = await findMemberById(a.orgId, a.crew.memberId);
  await db().update(schema.members).set({ userId: "user_b_only" }).where(eq(schema.members.id, ownerB!.id));
  await db().update(schema.members).set({ userId: "user_both" }).where(eq(schema.members.id, crewB!.id));
  await db().update(schema.members).set({ userId: "user_both" }).where(eq(schema.members.id, crewA!.id));

  const before = await snapshot(a.orgId);
  const footprint = await businessFootprint(b.orgId);
  assert.ok(footprint);
  assert.deepEqual(footprint.signIns, ["user_b_only"], "only the sign-in no other business has, never a super admin's");
  assert.deepEqual(footprint.files.filter((f) => f.startsWith("https://")), [STORED], "only B's own stored file, never a URL in its text or one A shares");
  assert.equal(footprint.phones.length, 2);

  const removedPhones: string[] = [];
  const deletedFiles: string[] = [];
  const deletedInboxes: string[] = [];
  setAgentMailGatewayForTests({ ...agentMailGateway(), deleteInbox: async (id) => void deletedInboxes.push(id) });
  try {
    await deleteBusiness(b.orgId, {
      photon: { ensureSharedUser: async () => assert.fail("no registrations made"), removeSharedUser: async (e164) => (removedPhones.push(e164), true) },
      deleteFile: async (url) => void deletedFiles.push(url),
    });
  } finally {
    setAgentMailGatewayForTests(null);
  }

  assert.deepEqual(removedPhones.sort(), footprint.phones);
  assert.deepEqual(deletedInboxes, ["inbox_b"]);
  assert.deepEqual(deletedFiles, footprint.files);
  assert.equal(await getOrganization(b.orgId), null);
  for (const { name, column } of removalTables) {
    const rows = await db().execute(sql`select 1 from ${sql.identifier(name)} where ${sql.identifier(column.name)} = ${b.orgId} limit 1`);
    assert.equal(rows.length, 0, `${name} still has B's rows`);
  }
  assert.equal(removalTables.filter((t) => t.column.name === "org_id").length, businessTables.length, "every business table is cleared");
  assert.equal(await snapshot(a.orgId), before, "A's rows are untouched");
  const users = (await db().select({ id: schema.user.id }).from(schema.user)).map((u) => u.id).sort();
  assert.deepEqual(users, ["user_admin", "user_both"]);
  const [adminSession] = await db().select().from(schema.session).where(eq(schema.session.id, "s_admin"));
  assert.equal(adminSession.activeOrganizationId, null, "a super admin who had it open isn't left pointing at it");
  await assert.rejects(deleteBusiness(b.orgId), /NO_SUCH_BUSINESS/);
});
