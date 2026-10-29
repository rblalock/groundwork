process.env.BLOB_FAKE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { approvals, followups, messages, ownerRequests, quoteRevisions, quotes } from "../schema/schema";
import { db } from "./db";
import { TEST_ORG, withTestDb } from "./test-db";
import { updateProfile } from "./profile";
import { addPhone, createMember, recordInbound, type Caller, type Member } from "./members";
import { saveItems, saveRule, versions } from "./pricebook";
import { saveCustomer, searchCustomers } from "./customers";
import {
  approveQuote,
  createQuote,
  getQuote,
  linkRecentAttachments,
  setAsideRecentAttachments,
  listQuotes,
  pendingForMember,
  quoteSummaryText,
  recentQuoteRef,
  requestOwnerApproval,
  revisionNumberAt,
  reviseQuote,
  setFollowup,
  setQuoteOutcome,
  turnQuoteRef,
  type Poster,
  type QuoteSummary,
} from "./quotes";

type Post = Parameters<Poster>;
function recorder() {
  const posts: Array<{ memberId: string; payload: Post[2]; kind: Post[3] }> = [];
  const post: Poster = async (_orgId, memberId, payload, kind) => {
    posts.push({ memberId, payload, kind });
    return { posted: true };
  };
  return { posts, post };
}

async function person(
  name: string,
  role: Member["role"],
  e164: string,
  service: "iMessage" | "SMS" | "RCS" = "iMessage",
): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  const phone = await addPhone(TEST_ORG, member.id, e164);
  await recordInbound(TEST_ORG, phone.id, `thread:${e164}`, new Date(), service);
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: e164 };
}

async function seed() {
  const owner = await person("Pat", "owner", "+13055550100");
  await updateProfile(TEST_ORG, { minimumChargeCents: 15000 }, owner.memberId);
  const [windows, screens, skylights] = await saveItems(
    TEST_ORG,
    [
      { name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 },
      { name: "gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 200 },
      { name: "gizmo check", unitKind: "each", unitLabel: "gizmo", priceCents: 2500, taxable: false },
    ],
    owner.memberId,
  );
  return { owner, windows, screens, skylights };
}

const NOW = new Date("2026-10-20T15:00:00Z"); // 11:00 in New York

withTestDb("a quote still missing a price posts no PDF, and its summary has no $0 total", async () => {
  const { owner, windows } = await seed();
  const { posts, post } = recorder();
  const nothingPriced = await createQuote(
    { title: "Back porch", lines: [{ name: "porch cleaning", unitLabel: "visit", quantity: 1 }] },
    owner,
    { post, now: NOW },
  );
  assert.equal(nothingPriced.state, "needs_owner");
  assert.equal(nothingPriced.pdfUrl, null);
  assert.equal(posts.length, 0);
  assert.equal(quoteSummaryText(nothingPriced, "en", "owner").split("\n")[0], "Quote for Back porch: not priced yet");

  const partly = await createQuote(
    {
      title: "Front porch",
      lines: [
        { itemId: windows.id, quantity: 20 },
        { name: "porch cleaning", unitLabel: "visit", quantity: 1 },
      ],
    },
    owner,
    { post, now: NOW },
  );
  assert.equal(posts.length, 0);
  assert.equal(quoteSummaryText(partly, "en", "owner").split("\n")[0], "Quote for Front porch: $240 so far");
  assert.match(quoteSummaryText(partly, "en", "member"), /or I can send it to the owner to fill in\.$/);
});

withTestDb("first quote with saved prices totals $392 and posts the PDF", async () => {
  const { owner, windows, screens } = await seed();
  const { posts, post } = recorder();
  const summary = await createQuote(
    {
      title: "4512 Palm Ave",
      lines: [
        { itemId: windows.id, quantity: 28 },
        { itemId: screens.id, quantity: 28 },
      ],
    },
    owner,
    { post, now: NOW },
  );
  assert.equal(summary.totalCents, 39200);
  assert.equal(summary.state, "ready");
  assert.equal(summary.status, "draft");
  assert.equal(summary.revisionNumber, 1);
  assert.equal(summary.minimumAppliedCents, 0);
  assert.equal(summary.lines[0].source, "pricebook");
  assert.match(summary.pdfUrl ?? "", /^fake:\/\/quotes\//);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].memberId, owner.memberId);
  assert.equal(posts[0].payload.file?.mimeType, "application/pdf");
  assert.ok(posts[0].payload.file?.data.length);
  assert.ok(posts[0].payload.file?.filename.endsWith(".pdf"));
  assert.equal(posts[0].payload.text, undefined, "the PDF goes without a caption; the summary follows it");
  assert.equal(posts[0].payload.asksApproval, true);

  const [rev] = await db().select().from(quoteRevisions).where(eq(quoteRevisions.quoteId, summary.quoteId));
  assert.equal(rev.validUntil, "2026-11-19"); // 30 days after 2026-10-20
  assert.equal(rev.customerLanguage, "en");
  assert.equal(rev.pricebookVersion, (await versions(TEST_ORG)).pricebookVersion);
  assert.equal(rev.createdByMemberId, owner.memberId);
});

withTestDb("the minimum fills a small quote and the customer's language is used", async () => {
  const { owner, windows } = await seed();
  const customer = await saveCustomer(TEST_ORG, { name: "Maria Lopez", language: "es", address: "9 Coral Way" }, owner.memberId);
  const { post } = recorder();
  const summary = await createQuote(
    {
      title: "Coral Way",
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      lines: [{ itemId: windows.id, quantity: 2 }],
    },
    owner,
    { post, now: NOW },
  );
  assert.equal(summary.totalCents, 15000);
  assert.equal(summary.minimumAppliedCents, 12600);
  assert.equal(summary.customerName, "Maria Lopez");
  assert.equal(summary.propertyAddress, "9 Coral Way");
  const [rev] = await db().select().from(quoteRevisions).where(eq(quoteRevisions.quoteId, summary.quoteId));
  assert.equal(rev.customerLanguage, "es");
});

withTestDb("an SMS member gets a text post that ends with the pdf link instead of a file", async () => {
  const { windows } = await seed();
  const crew = await person("Carlos", "member", "+13055550142", "SMS");
  const { posts, post } = recorder();
  const summary = await createQuote(
    { title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 20 }] },
    crew,
    { post, now: NOW },
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.file, undefined);
  assert.ok(summary.pdfUrl);
  const lines = (posts[0].payload.text ?? "").split("\n");
  assert.equal(lines[lines.length - 1], summary.pdfUrl);
});

withTestDb("an unpriced line makes the quote needs_owner and names the item", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const summary = await createQuote(
    {
      title: "Coral Way",
      lines: [
        { itemId: windows.id, quantity: 16 },
        { name: "skylight", quantity: 2 },
      ],
    },
    owner,
    { post, now: NOW },
  );
  assert.equal(summary.state, "needs_owner");
  assert.equal(summary.status, "needs_owner");
  assert.deepEqual(summary.reasons, ["unpriced:skylight"]);
  assert.equal(summary.lines[1].source, "unpriced");
  assert.equal(summary.lines[1].totalCents, null);
});

withTestDb("first-quote interview: name-only lines plus \"just call it 400\" is ready and approves", async () => {
  const { owner } = await seed();
  const before = await versions(TEST_ORG);
  const { post } = recorder();
  const summary = await createQuote(
    {
      title: "4512 Palm Ave",
      lines: [
        { name: "widget service", unitLabel: "widget", quantity: 28 },
        { name: "gadget fitting", unitLabel: "gadget", quantity: 28 },
      ],
      adjustments: [{ kind: "override", amountCents: 40000, reason: "just call it 400" }],
    },
    owner,
    { post, now: NOW },
  );
  assert.equal(summary.state, "ready");
  assert.equal(summary.status, "draft");
  assert.deepEqual(summary.reasons, []);
  assert.equal(summary.totalCents, 40000);
  assert.match(quoteSummaryText(summary, "en", "owner"), /Reply ok to approve/);
  assert.deepEqual(await versions(TEST_ORG), before);
  const approved = await approveQuote(summary.quoteId, owner, { post, now: NOW });
  assert.ok(approved.ok);
  if (approved.ok) assert.equal(approved.quote.totalCents, 40000);
});

withTestDb("a named line with a price is an override line and an unknown item throws", async () => {
  const { owner } = await seed();
  const { post } = recorder();
  const summary = await createQuote(
    { title: "Odd job", lines: [{ name: "special trip", unitLabel: "trip", quantity: 1, unitCents: 30000 }] },
    owner,
    { post, now: NOW },
  );
  assert.equal(summary.lines[0].source, "override");
  assert.equal(summary.lines[0].itemId, null);
  assert.equal(summary.totalCents, 30000);
  await assert.rejects(
    createQuote({ title: "x", lines: [{ itemId: "item_nope", quantity: 1 }] }, owner, { post, now: NOW }),
    /UNKNOWN_ITEM:item_nope/,
  );
});

withTestDb("a total override records an adjustment and leaves the pricebook alone", async () => {
  const { owner, windows, screens } = await seed();
  const before = await versions(TEST_ORG);
  const { post } = recorder();
  const summary = await createQuote(
    {
      title: "Palm Ave",
      lines: [
        { itemId: windows.id, quantity: 28 },
        { itemId: screens.id, quantity: 28 },
      ],
      adjustments: [{ kind: "override", amountCents: 37500, reason: "owner said call it 375" }],
    },
    owner,
    { post, now: NOW },
  );
  assert.equal(summary.totalCents, 37500);
  assert.equal(summary.adjustmentCents, -1700);
  assert.equal(summary.lines[0].unitCents, 1200);
  assert.deepEqual(await versions(TEST_ORG), before);
  const [rev] = await db().select().from(quoteRevisions).where(eq(quoteRevisions.quoteId, summary.quoteId));
  assert.equal(rev.adjustments[0].memberId, owner.memberId);
});

withTestDb("rules apply by id and an unknown rule throws", async () => {
  const { owner, windows } = await seed();
  const rule = await saveRule(
    TEST_ORG,
    { text: "add $50 for high work", kind: "pricing_modifier", effect: { op: "add_fixed", amount: 5000, appliesTo: "any" } },
    owner.memberId,
  );
  const { post } = recorder();
  const summary = await createQuote(
    { title: "Tall", lines: [{ itemId: windows.id, quantity: 20 }], ruleIds: [rule.id] },
    owner,
    { post, now: NOW },
  );
  assert.equal(summary.totalCents, 29000);
  assert.deepEqual(summary.ruleLines.map((r) => r.cents), [5000]);
  await assert.rejects(
    createQuote({ title: "x", lines: [{ itemId: windows.id, quantity: 1 }], ruleIds: ["rule_nope"] }, owner, { post, now: NOW }),
    /UNKNOWN_RULE:rule_nope/,
  );
});

withTestDb("a customer find_customer didn't find is saved with the quote, at its address", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const summary = await createQuote(
    { title: "412 Oak St", customer: { name: "Maria Alvarez", address: "412 Oak St" }, lines: [{ itemId: windows.id, quantity: 20 }] },
    owner,
    { post, now: NOW },
  );
  const [quote] = await db().select().from(quotes).where(eq(quotes.id, summary.quoteId));
  const [maria] = await searchCustomers(TEST_ORG, "Maria Alvarez");
  assert.equal(quote.customerId, maria.id);
  assert.equal(quote.propertyId, maria.properties[0].id);
  assert.deepEqual(maria.properties.map((p) => p.address), ["412 Oak St"]);
  assert.equal(summary.customerName, "Maria Alvarez");
  assert.equal(summary.propertyAddress, "412 Oak St");

  // A customerId wins: no second customer is saved.
  const again = await createQuote(
    { title: "412 Oak St", customerId: maria.id, customer: { name: "Maria Alvarez" }, lines: [{ itemId: windows.id, quantity: 10 }] },
    owner,
    { post, now: NOW },
  );
  assert.equal(again.customerId, maria.id);
  assert.equal((await searchCustomers(TEST_ORG, "Maria")).length, 1);
});

withTestDb("revise adds a line and bumps the revision number", async () => {
  const { owner, windows, screens } = await seed();
  const { posts, post } = recorder();
  const first = await createQuote(
    { title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 20 }], customerNotes: "Back gate is open" },
    owner,
    { post, now: NOW },
  );
  const second = await reviseQuote(
    {
      quoteId: first.quoteId,
      lines: [
        { itemId: windows.id, quantity: 20 },
        { itemId: screens.id, quantity: 20 },
      ],
    },
    owner,
    { post, now: NOW },
  );
  assert.equal(second.quoteId, first.quoteId);
  assert.equal(second.revisionNumber, 2);
  assert.equal(second.totalCents, 28000);
  assert.equal(posts.length, 2);
  const revisions = await db().select().from(quoteRevisions).where(eq(quoteRevisions.quoteId, first.quoteId));
  assert.equal(revisions.length, 2);
  const one = revisions.find((r) => r.number === 1)!;
  assert.equal(one.totalCents, 24000);
  assert.equal(revisions.find((r) => r.number === 2)!.customerNotes, "Back gate is open");
  const detail = await getQuote(TEST_ORG, first.quoteId);
  assert.deepEqual(detail?.revisions.map((r) => r.number), [2, 1]);

  // Without new lines the previous ones carry over.
  const third = await reviseQuote(
    { quoteId: first.quoteId, adjustments: [{ kind: "discount", amountCents: 1000, reason: "repeat customer" }] },
    owner,
    { post, now: NOW },
  );
  assert.equal(third.revisionNumber, 3);
  assert.equal(third.totalCents, 27000);
});

withTestDb("revising an approved quote returns it to draft and cancels its nudge", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  await approveQuote(created.quoteId, owner, { post, now: NOW });
  const revised = await reviseQuote(
    { quoteId: created.quoteId, lines: [{ itemId: windows.id, quantity: 25 }] },
    owner,
    { post, now: NOW },
  );
  assert.equal(revised.status, "draft");
  const rows = await db().select().from(followups).where(eq(followups.quoteId, created.quoteId));
  assert.deepEqual(rows.map((r) => r.status), ["cancelled"]);
});

withTestDb("approve without an id names the lone candidate instead of approving it", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const created = await createQuote({ title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  const result = await approveQuote(undefined, owner, { post, now: NOW });
  assert.equal(result.ok, false);
  if (result.ok || !("candidates" in result)) return assert.fail("expected candidates");
  assert.equal(result.reason, "ambiguous");
  assert.deepEqual(result.candidates.map((c) => c.quoteId), [created.quoteId]);
  const [row] = await db().select().from(quotes).where(eq(quotes.id, created.quoteId));
  assert.equal(row.status, "draft");
  assert.equal((await db().select().from(approvals)).length, 0);
});

withTestDb("approve by id approves it and schedules a nudge", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const created = await createQuote({ title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  const result = await approveQuote(created.quoteId, owner, { post, messageId: "msg_1", now: NOW });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.quote.quoteId, created.quoteId);
  assert.equal(result.quote.status, "approved");
  const [approval] = await db().select().from(approvals);
  assert.equal(approval.memberId, owner.memberId);
  assert.equal(approval.messageId, "msg_1");
  const [nudge] = await db().select().from(followups).where(eq(followups.quoteId, created.quoteId));
  assert.equal(nudge.kind, "nudge");
  assert.equal(nudge.status, "pending");
  assert.equal(nudge.memberId, owner.memberId);
  assert.equal(nudge.dueAt.toISOString(), "2026-10-23T15:00:00.000Z");
  const [row] = await db().select().from(quotes).where(eq(quotes.id, created.quoteId));
  assert.equal(row.approvedByMemberId, owner.memberId);
  assert.ok(row.approvedAt);

  // Approving again is a no-op that does not add a second approval or nudge.
  const again = await approveQuote(created.quoteId, owner, { post, now: NOW });
  assert.ok(again.ok);
  assert.equal((await db().select().from(approvals)).length, 1);
  assert.equal((await db().select().from(followups)).length, 1);
});

const pdfKeywords = async (data: Buffer | undefined) => (await PDFDocument.load(data ?? Buffer.alloc(0))).getKeywords();

withTestDb("approval re-renders the PDF without the draft mark and posts it to the approver", async () => {
  const { owner, windows } = await seed();
  const { posts, post } = recorder();
  const created = await createQuote({ title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  assert.equal(await pdfKeywords(posts[0].payload.file?.data), "draft");
  posts.length = 0;

  const result = await approveQuote(created.quoteId, owner, { post, now: NOW });
  assert.ok(result.ok);
  assert.equal(posts.length, 1);
  const [pdf] = posts;
  assert.equal(pdf.memberId, owner.memberId);
  assert.equal(pdf.kind, "system");
  assert.equal(pdf.payload.quoteId, created.quoteId);
  assert.ok(!pdf.payload.asksApproval, "an approved PDF asks nothing");
  assert.equal(pdf.payload.file?.mimeType, "application/pdf");
  assert.equal(await pdfKeywords(pdf.payload.file?.data), undefined);
  if (result.ok) assert.ok(result.quote.pdfUrl);

  // Approving again re-sends nothing.
  await approveQuote(created.quoteId, owner, { post, now: NOW });
  assert.equal(posts.length, 1);
});

withTestDb("an SMS approver gets the approved PDF as a link", async () => {
  const { windows } = await seed();
  const admin = await person("Ana", "admin", "+13055550111", "SMS");
  const { posts, post } = recorder();
  const created = await createQuote({ title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 20 }] }, admin, { post, now: NOW });
  posts.length = 0;
  const result = await approveQuote(created.quoteId, admin, { post, now: NOW });
  assert.ok(result.ok);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.file, undefined);
  const lines = (posts[0].payload.text ?? "").split("\n");
  if (result.ok) assert.equal(lines[lines.length - 1], result.quote.pdfUrl);
});

withTestDb("the nudge moves out of quiet hours", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const night = new Date("2026-10-21T03:00:00Z"); // 23:00 in New York; +3 days is still 23:00
  const created = await createQuote({ title: "Late", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: night });
  await approveQuote(created.quoteId, owner, { post, now: night });
  const [nudge] = await db().select().from(followups);
  assert.equal(nudge.dueAt.toISOString(), "2026-10-24T11:00:00.000Z"); // 07:00 New York
});

withTestDb("setFollowup replaces the pending nudge, respects quiet hours, and needs an approved quote", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const created = await createQuote({ title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  await assert.rejects(setFollowup(created.quoteId, 5, owner, { now: NOW }), /NOT_APPROVED/);
  await approveQuote(created.quoteId, owner, { post, now: NOW });
  const { dueAt } = await setFollowup(created.quoteId, 5, owner, { now: NOW });
  assert.equal(dueAt.toISOString(), "2026-10-25T15:00:00.000Z");
  const rows = await db().select().from(followups).where(eq(followups.quoteId, created.quoteId));
  assert.deepEqual(rows.map((r) => r.status).sort(), ["cancelled", "pending"]);
  const night = new Date("2026-10-21T03:00:00Z"); // 23:00 in New York
  const later = await setFollowup(created.quoteId, 1, owner, { now: night });
  assert.equal(later.dueAt.toISOString(), "2026-10-22T11:00:00.000Z"); // 07:00 New York
  assert.equal((await db().select().from(followups).where(eq(followups.status, "pending"))).length, 1);
});

withTestDb("approve with nothing pending returns nothing_to_approve", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const result0 = await approveQuote(undefined, owner, { post, now: NOW });
  assert.deepEqual(result0, { ok: false, reason: "nothing_to_approve", candidates: [] });
  // A draft untouched for more than seven days is not a candidate.
  await createQuote({ title: "Old", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, {
    post,
    now: new Date("2026-10-01T15:00:00Z"),
  });
  const result = await approveQuote(undefined, owner, { post, now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "nothing_to_approve");
});

withTestDb("approve with two drafts returns ambiguous with both", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const a = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  const b = await createQuote({ title: "B", lines: [{ itemId: windows.id, quantity: 30 }] }, owner, { post, now: NOW });
  const result = await approveQuote(undefined, owner, { post, now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "ambiguous");
  assert.deepEqual(result.candidates.map((c) => c.quoteId).sort(), [a.quoteId, b.quoteId].sort());
  // Naming one resolves it.
  const named = await approveQuote(b.quoteId, owner, { post, now: NOW });
  assert.ok(named.ok);
});

withTestDb("crew cannot approve", async () => {
  const { windows } = await seed();
  const crew = await person("Carlos", "member", "+13055550142");
  const { post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, crew, { post, now: NOW });
  const result = await approveQuote(created.quoteId, crew, { post, now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_privileged");
  const [row] = await db().select().from(quotes).where(eq(quotes.id, created.quoteId));
  assert.equal(row.status, "draft");
});

withTestDb("a quote that still needs the owner is reported not_ready, not thrown", async () => {
  const { owner } = await seed();
  const { posts, post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ name: "thing", quantity: 1 }] }, owner, { post, now: NOW });
  posts.length = 0;
  for (const id of [created.quoteId, undefined]) {
    const result = await approveQuote(id, owner, { post, now: NOW });
    assert.equal(result.ok, false);
    if (result.ok || !("quote" in result)) return assert.fail("expected a quote in the result");
    assert.equal(result.reason, "not_ready");
    assert.equal(result.quote.quoteId, created.quoteId);
    assert.deepEqual(result.quote.reasons, ["unpriced:thing"]);
  }
  const [row] = await db().select().from(quotes).where(eq(quotes.id, created.quoteId));
  assert.equal(row.status, "needs_owner");
  assert.equal((await db().select().from(approvals)).length, 0);
  assert.equal(posts.length, 0);
});

withTestDb("unpriced drafts are not approval candidates", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  await createQuote({ title: "Stale", lines: [{ name: "thing", quantity: 1 }] }, owner, { post, now: NOW });
  const ready = await createQuote({ title: "Good", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  const result = await approveQuote(undefined, owner, { post, now: NOW });
  assert.equal(result.ok, false);
  if (!result.ok && "candidates" in result) assert.deepEqual(result.candidates.map((c) => c.quoteId), [ready.quoteId]);
  assert.ok((await approveQuote(ready.quoteId, owner, { post, now: NOW })).ok);

  // Two unready drafts with nothing ready: nothing to approve rather than a guess.
  await createQuote({ title: "Stale 2", lines: [{ name: "other", quantity: 1 }] }, owner, { post, now: NOW });
  const none = await approveQuote(undefined, owner, { post, now: NOW });
  assert.deepEqual(none, { ok: false, reason: "nothing_to_approve", candidates: [] });
});

withTestDb("approving with a stale expected revision returns revision_changed and approves nothing", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const first = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  await reviseQuote({ quoteId: first.quoteId, lines: [{ itemId: windows.id, quantity: 25 }] }, owner, { post, now: NOW });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const since = new Date(); // the owner's tapback turn starts after the revise
  const stale = await approveQuote(first.quoteId, owner, { post, now: NOW, expectedRevisionNumber: 1 });
  assert.equal(stale.ok, false);
  if (stale.ok || !("quote" in stale)) return assert.fail("expected a quote in the result");
  assert.equal(stale.reason, "revision_changed");
  assert.equal(stale.quote.revisionNumber, 2);
  assert.equal((await db().select().from(approvals)).length, 0);
  assert.equal((await db().select().from(followups)).length, 0);
  const [row] = await db().select().from(quotes).where(eq(quotes.id, first.quoteId));
  assert.equal(row.status, "draft");

  // The reply re-sends revision 2, so a 👍 on that reply can approve it.
  assert.deepEqual(await turnQuoteRef(TEST_ORG, owner.memberId, since), { quoteId: first.quoteId, asksApproval: true });

  const matching = await approveQuote(first.quoteId, owner, { post, now: NOW, expectedRevisionNumber: 2 });
  assert.ok(matching.ok);
  // A repeat tapback on the old revision of an approved quote also reports the change.
  const repeat = await approveQuote(first.quoteId, owner, { post, now: NOW, expectedRevisionNumber: 1 });
  assert.equal(repeat.ok, false);
});

withTestDb("revisionNumberAt returns the latest revision at or before a time", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const t1 = new Date("2026-10-20T15:00:00Z");
  const t2 = new Date("2026-10-20T16:00:00Z");
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: t1 });
  await reviseQuote({ quoteId: created.quoteId, lines: [{ itemId: windows.id, quantity: 25 }] }, owner, { post, now: t2 });
  assert.equal(await revisionNumberAt(TEST_ORG, created.quoteId, new Date("2026-10-20T14:59:59Z")), null);
  assert.equal(await revisionNumberAt(TEST_ORG, created.quoteId, t1), 1);
  assert.equal(await revisionNumberAt(TEST_ORG, created.quoteId, new Date("2026-10-20T15:30:00Z")), 1);
  assert.equal(await revisionNumberAt(TEST_ORG, created.quoteId, t2), 2);
  assert.equal(await revisionNumberAt(TEST_ORG, "quo_missing", t2), null);
});

withTestDb("a repeat approve and an owner request both mark the quote as recently touched", async () => {
  const { owner, windows } = await seed();
  const crew = await person("Carlos", "member", "+13055550142");
  const { post } = recorder();
  const a = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  const b = await createQuote({ title: "B", lines: [{ itemId: windows.id, quantity: 21 }] }, crew, { post, now: NOW });
  const since = new Date(Date.now() - 60_000);
  await approveQuote(a.quoteId, owner, { post, now: NOW });
  await createQuote({ title: "C", lines: [{ itemId: windows.id, quantity: 22 }] }, owner, { post, now: NOW });
  assert.notEqual(await recentQuoteRef(TEST_ORG, owner.memberId, since), a.quoteId);
  await approveQuote(a.quoteId, owner, { post, now: NOW }); // repeat tapback
  assert.equal(await recentQuoteRef(TEST_ORG, owner.memberId, since), a.quoteId);
  await requestOwnerApproval(b.quoteId, crew, { post });
  assert.equal(await recentQuoteRef(TEST_ORG, crew.memberId, since), b.quoteId);
  await createQuote({ title: "D", lines: [{ itemId: windows.id, quantity: 23 }] }, crew, { post, now: NOW });
  assert.notEqual(await recentQuoteRef(TEST_ORG, crew.memberId, since), b.quoteId);
  await requestOwnerApproval(b.quoteId, crew, { post });
  assert.equal(await recentQuoteRef(TEST_ORG, crew.memberId, since), b.quoteId);
});

withTestDb("request_owner_approval notifies owners and marks needs_owner; approval tells the crew member", async () => {
  const { owner, windows, screens } = await seed();
  const admin = await person("Ana", "admin", "+13055550111");
  const crew = await person("Carlos", "member", "+13055550142");
  const { posts, post } = recorder();
  const created = await createQuote(
    {
      title: "4512 Palm Ave",
      lines: [
        { itemId: windows.id, quantity: 28 },
        { itemId: screens.id, quantity: 28 },
      ],
    },
    crew,
    { post, now: NOW },
  );
  posts.length = 0;
  const result = await requestOwnerApproval(created.quoteId, crew, { post });
  assert.deepEqual([...result.notified].sort(), ["Ana", "Pat"]);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((p) => p.memberId).sort(), [owner.memberId, admin.memberId].sort());
  assert.equal(
    posts[0].payload.text,
    "Carlos drafted $392 for 4512 Palm Ave (28 × widget service @ $12 = $336 · 28 × gadget fitting @ $2 = $56). Reply ok or 👍 to approve, or ask me about it.",
  );
  assert.ok(posts.every((p) => p.payload.quoteId === created.quoteId && p.kind === "proactive"));
  assert.ok(posts.every((p) => p.payload.asksApproval === true));
  const [row] = await db().select().from(quotes).where(eq(quotes.id, created.quoteId));
  assert.equal(row.status, "needs_owner");
  const requests = await db().select().from(ownerRequests);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, "pending");
  assert.equal(requests[0].requestedByMemberId, crew.memberId);

  // Asking twice does not create a second request.
  await requestOwnerApproval(created.quoteId, crew, { post });
  assert.equal((await db().select().from(ownerRequests)).length, 1);

  posts.length = 0;
  const approved = await approveQuote(created.quoteId, owner, { post, now: NOW });
  assert.ok(approved.ok);
  assert.equal((await db().select().from(ownerRequests))[0].status, "approved");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].memberId, owner.memberId, "the approved PDF goes to the approver");
  assert.ok(posts[0].payload.file);
  assert.equal(posts[1].memberId, crew.memberId);
  assert.equal(posts[1].payload.quoteId, created.quoteId);
  assert.match(posts[1].payload.text ?? "", /Pat approved/);
});

withTestDb("the owner's notice marks prices and totals the crew member set", async () => {
  const { windows, screens } = await seed();
  const crew = await person("Carlos", "member", "+13055550142");
  const { posts, post } = recorder();
  const created = await createQuote(
    {
      title: "12 Elm St",
      lines: [
        { itemId: windows.id, quantity: 10 },
        { itemId: screens.id, quantity: 10, unitCents: 300 },
        { name: "special trip", quantity: 1, unitCents: 5000 },
      ],
    },
    crew,
    { post, now: NOW },
  );
  posts.length = 0;
  await requestOwnerApproval(created.quoteId, crew, { post, now: NOW });
  assert.equal(
    posts[0].payload.text,
    "Carlos drafted $200 for 12 Elm St (10 × widget service @ $12 = $120 · 10 × gadget fitting @ $3 = $30 (Carlos's price) · " +
      "special trip $50 (Carlos's price)). Reply ok or 👍 to approve, or ask me about it.",
  );

  await reviseQuote(
    { quoteId: created.quoteId, adjustments: [{ kind: "override", amountCents: 25000, reason: "call it 250" }] },
    crew,
    { post, now: NOW },
  );
  posts.length = 0;
  await requestOwnerApproval(created.quoteId, crew, { post, now: NOW });
  assert.match(posts[0].payload.text ?? "", /^Carlos drafted \$250 \(total set by Carlos\) for 12 Elm St/);
});

withTestDb("outcomes: sent keeps follow-ups, won cancels them, crew can only mark sent", async () => {
  const { owner, windows } = await seed();
  const crew = await person("Carlos", "member", "+13055550142");
  const { post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, crew, { post, now: NOW });
  await assert.rejects(setQuoteOutcome(created.quoteId, "sent", crew, { now: NOW }), /NOT_APPROVED/);
  await approveQuote(created.quoteId, owner, { post, now: NOW });
  await assert.rejects(setQuoteOutcome(created.quoteId, "won", crew, { now: NOW }), /NOT_PRIVILEGED/);
  const sent = await setQuoteOutcome(created.quoteId, "sent", crew, { now: NOW });
  assert.equal(sent.status, "sent");
  assert.equal((await db().select().from(followups))[0].status, "pending");
  const won = await setQuoteOutcome(created.quoteId, "won", owner, { now: NOW });
  assert.equal(won.status, "won");
  assert.equal((await db().select().from(followups))[0].status, "cancelled");
  const [row] = await db().select().from(quotes).where(eq(quotes.id, created.quoteId));
  assert.ok(row.outcomeAt);
});

withTestDb("an owner marking a draft sent approves it first, PDF and all", async () => {
  const { owner, windows } = await seed();
  const { posts, post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  posts.length = 0;
  const sent = await setQuoteOutcome(created.quoteId, "sent", owner, { post, now: NOW });
  assert.equal(sent.status, "sent");
  const [row] = await db().select().from(quotes).where(eq(quotes.id, created.quoteId));
  assert.equal(row.approvedByMemberId, owner.memberId);
  assert.equal((await db().select().from(approvals)).length, 1);
  assert.deepEqual((await db().select().from(followups)).map((f) => [f.kind, f.status]), [["nudge", "pending"]]);
  assert.equal(posts.length, 1, "the approved PDF");
  assert.ok(posts[0].payload.file);

  // A quote that still needs prices cannot be approved, so it cannot be marked sent either.
  const unready = await createQuote({ title: "B", lines: [{ name: "thing", quantity: 1 }] }, owner, { post, now: NOW });
  await assert.rejects(setQuoteOutcome(unready.quoteId, "sent", owner, { post, now: NOW }), /NOT_READY/);
  assert.equal((await db().select().from(quotes).where(eq(quotes.id, unready.quoteId)))[0].status, "needs_owner");
});

withTestDb("void deletes the pdf and cancels follow-ups", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  assert.ok(created.pdfUrl);
  await approveQuote(created.quoteId, owner, { post, now: NOW });
  const voided = await setQuoteOutcome(created.quoteId, "void", owner, { now: NOW });
  assert.equal(voided.status, "void");
  assert.equal(voided.pdfUrl, null);
  const [rev] = await db().select().from(quoteRevisions).where(eq(quoteRevisions.quoteId, created.quoteId));
  assert.equal(rev.pdfUrl, null);
  assert.equal((await db().select().from(followups))[0].status, "cancelled");
  await assert.rejects(
    reviseQuote({ quoteId: created.quoteId, title: "B" }, owner, { post, now: NOW }),
    /QUOTE_CLOSED/,
  );
});

withTestDb("pendingForMember lists owner requests for the owner and own drafts for crew", async () => {
  const { owner, windows } = await seed();
  const crew = await person("Carlos", "member", "+13055550142");
  const other = await person("Dee", "member", "+13055550143");
  const { post } = recorder();
  const mine = await createQuote({ title: "Palm Ave", lines: [{ itemId: windows.id, quantity: 28 }] }, crew, { post, now: NOW });
  await createQuote({ title: "Not mine", lines: [{ itemId: windows.id, quantity: 20 }] }, other, { post, now: NOW });
  assert.deepEqual(await pendingForMember(owner), []);
  await requestOwnerApproval(mine.quoteId, crew, { post });

  const ownerItems = await pendingForMember(owner);
  assert.equal(ownerItems.length, 1);
  assert.match(ownerItems[0], /Carlos drafted \$336 for Palm Ave/);
  const crewItems = await pendingForMember(crew);
  assert.equal(crewItems.length, 1);
  assert.match(crewItems[0], /Palm Ave/);

  // An approved quote shows up for the owner once its nudge is due.
  await approveQuote(mine.quoteId, owner, { post, now: NOW });
  assert.deepEqual(await pendingForMember(owner, { now: NOW }), []);
  const later = await pendingForMember(owner, { now: new Date("2026-10-24T00:00:00Z") });
  assert.equal(later.length, 1);
  assert.match(later[0], /Palm Ave/);
  assert.deepEqual(await pendingForMember(crew), []);
});

withTestDb("pendingForMember never returns more than three items", async () => {
  const { windows } = await seed();
  const crew = await person("Carlos", "member", "+13055550142");
  const { post } = recorder();
  for (const title of ["A", "B", "C", "D"]) {
    await createQuote({ title, lines: [{ itemId: windows.id, quantity: 20 }] }, crew, { post, now: NOW });
  }
  assert.equal((await pendingForMember(crew)).length, 3);
});

withTestDb("quote posts carry quoteId and recentQuoteRef returns the last touched quote", async () => {
  const { owner, windows } = await seed();
  const crew = await person("Carlos", "member", "+13055550142");
  const { posts, post } = recorder();
  const since = new Date(Date.now() - 60_000);
  assert.equal(await recentQuoteRef(TEST_ORG, owner.memberId, since), null);
  const a = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  assert.ok(posts.every((p) => p.payload.quoteId === a.quoteId));
  assert.equal(await recentQuoteRef(TEST_ORG, owner.memberId, since), a.quoteId);
  const b = await createQuote({ title: "B", lines: [{ itemId: windows.id, quantity: 21 }] }, owner, { post, now: NOW });
  assert.equal(await recentQuoteRef(TEST_ORG, owner.memberId, since), b.quoteId);
  await reviseQuote({ quoteId: a.quoteId, title: "A2" }, owner, { post, now: NOW });
  assert.equal(await recentQuoteRef(TEST_ORG, owner.memberId, since), a.quoteId);
  assert.equal(await recentQuoteRef(TEST_ORG, crew.memberId, since), null);
  assert.equal(await recentQuoteRef(TEST_ORG, owner.memberId, new Date(Date.now() + 60_000)), null);
  await setQuoteOutcome(b.quoteId, "void", owner, { now: NOW });
  assert.equal(await recentQuoteRef(TEST_ORG, owner.memberId, since), b.quoteId);
  assert.ok(posts.every((p) => typeof p.payload.quoteId === "string"));
});

withTestDb("a failed post does not fail the save", async () => {
  const { owner, windows } = await seed();
  const post: Poster = async () => {
    throw new Error("transport down");
  };
  const summary = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  assert.ok(summary.pdfUrl);
  assert.equal(summary.totalCents, 24000);
});

withTestDb("listQuotes filters by status and query; getQuote returns the detail", async () => {
  const { owner, windows } = await seed();
  const customer = await saveCustomer(TEST_ORG, { name: "Maria Lopez", address: "4512 Palm Ave" }, owner.memberId);
  const { post } = recorder();
  const a = await createQuote(
    { title: "Palm job", customerId: customer.id, lines: [{ itemId: windows.id, quantity: 20 }] },
    owner,
    { post, now: NOW },
  );
  await createQuote({ title: "Coral job", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  await approveQuote(a.quoteId, owner, { post, now: NOW });
  assert.equal((await listQuotes(TEST_ORG, {})).length, 2);
  assert.deepEqual((await listQuotes(TEST_ORG, { status: ["approved"] })).map((q) => q.quoteId), [a.quoteId]);
  assert.deepEqual((await listQuotes(TEST_ORG, { query: "maria" })).map((q) => q.quoteId), [a.quoteId]);
  assert.deepEqual((await listQuotes(TEST_ORG, { query: "coral" })).map((q) => q.title), ["Coral job"]);
  assert.equal((await listQuotes(TEST_ORG, { limit: 1 })).length, 1);
  const detail = await getQuote(TEST_ORG, a.quoteId);
  assert.equal(detail?.customer?.name, "Maria Lopez");
  assert.equal(detail?.createdBy, "Pat");
  assert.equal(await getQuote(TEST_ORG, "quo_missing"), null);
});

withTestDb("photos sent with a job print on the quote's PDF, and a later one is added by revising", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const jpeg = (await import("jpeg-js")).default;
  const dir = await mkdtemp(`${tmpdir()}/gw-photos-`);
  try {
    const file = `${dir}/job.jpg`;
    await writeFile(file, jpeg.encode({ width: 60, height: 40, data: Buffer.alloc(60 * 40 * 4, 0x80) }, 80).data);
    const { owner, windows } = await seed();
    const photoMessage = (id: string) => ({
      id,
      orgId: TEST_ORG,
      memberId: owner.memberId,
      phoneE164: owner.phoneE164!,
      direction: "inbound" as const,
      kind: "user" as const,
      body: "",
      attachments: [{ type: "image" as const, url: pathToFileURL(file).href, name: "job.jpg", mimeType: "image/jpeg" }],
    });
    const pages = async (posted: Array<{ payload: Post[2] }>) =>
      (await PDFDocument.load(posted.at(-1)!.payload.file!.data)).getPageCount();

    const since = new Date(Date.now() - 60_000);
    await db().insert(messages).values(photoMessage("msg_photo_1"));
    const { posts, post } = recorder();
    const created = await createQuote(
      { title: "A", lines: [{ itemId: windows.id, quantity: 20 }] },
      owner,
      { post, now: NOW, photosSince: since },
    );
    assert.equal(await pages(posts), 2);

    await db().insert(messages).values(photoMessage("msg_photo_2"));
    await reviseQuote({ quoteId: created.quoteId }, owner, { post, now: NOW, photosSince: since });
    assert.equal(await pages(posts), 2);
    assert.equal((await getQuote(TEST_ORG, created.quoteId))?.attachments.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

withTestDb("files set aside as a document since the last reply never attach to a quote", async () => {
  const { owner, windows } = await seed();
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const row = (id: string, minutesAgo: number, extra: Partial<typeof messages.$inferInsert> = {}) => ({
    id,
    orgId: TEST_ORG,
    memberId: owner.memberId,
    phoneE164: owner.phoneE164!,
    direction: "inbound" as const,
    kind: "user" as const,
    body: "",
    attachments: [{ type: "image" as const, url: `fake://inbound/${id}.jpg`, name: `${id}.jpg`, mimeType: "image/jpeg" }],
    createdAt: at(minutesAgo),
    ...extra,
  });
  await db().insert(messages).values([
    row("msg_job_photo", 20),
    row("msg_reply", 10, { direction: "outbound", kind: "assistant", body: "Got it.", attachments: [] }),
    row("msg_price_list", 2),
    row("msg_price_list_2", 1),
  ]);
  assert.equal(await setAsideRecentAttachments(TEST_ORG, owner.memberId, { windowMs: 30 * 60_000 }), 2);
  assert.equal(await setAsideRecentAttachments(TEST_ORG, owner.memberId, { windowMs: 30 * 60_000 }), 0, "already set aside");
  const rows = await db().select().from(messages).where(eq(messages.orgId, TEST_ORG));
  const flagged = Object.fromEntries(rows.map((r) => [r.id, r.attachments.map((a) => a.document ?? false)]));
  assert.deepEqual(flagged, { msg_job_photo: [false], msg_reply: [], msg_price_list: [true], msg_price_list_2: [true] });

  const { post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 2 }] }, owner, {
    post,
    now: NOW,
    photosSince: at(30),
  });
  assert.deepEqual((await getQuote(TEST_ORG, created.quoteId))!.attachments.map((a) => a.name), ["msg_job_photo.jpg"]);
  // A photo already on a quote is left alone.
  await db().update(messages).set({ createdAt: at(1) }).where(eq(messages.id, "msg_job_photo"));
  assert.equal(await setAsideRecentAttachments(TEST_ORG, owner.memberId, { windowMs: 30 * 60_000 }), 0);
});

withTestDb("a photo taken off a quote leaves its PDF, needs approving again, and isn't attached again", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const jpeg = (await import("jpeg-js")).default;
  const dir = await mkdtemp(`${tmpdir()}/gw-photos-`);
  try {
    const file = `${dir}/job.jpg`;
    // Tall enough that two fill a page.
    await writeFile(file, jpeg.encode({ width: 300, height: 400, data: Buffer.alloc(300 * 400 * 4, 0x80) }, 80).data);
    const { owner, windows } = await seed();
    const url = pathToFileURL(file).href;
    await db().insert(messages).values(
      ["front.jpg", "back.jpg", "side.jpg"].map((name, i) => ({
        id: `msg_photo_${i}`,
        orgId: TEST_ORG,
        memberId: owner.memberId,
        phoneE164: owner.phoneE164!,
        direction: "inbound" as const,
        kind: "user" as const,
        body: "",
        attachments: [{ type: "image" as const, url: `${url}?${i}`, name, mimeType: "image/jpeg" }],
        createdAt: new Date(Date.now() - 50_000 + i * 1000),
      })),
    );
    const since = new Date(Date.now() - 60_000);
    const { posts, post } = recorder();
    const pages = async () => (await PDFDocument.load(posts.at(-1)!.payload.file!.data)).getPageCount();
    const created = await createQuote(
      { title: "A", lines: [{ itemId: windows.id, quantity: 20 }] },
      owner,
      { post, now: NOW, photosSince: since },
    );
    assert.equal(await pages(), 3, "the quote, then three photos two to a page");
    assert.equal((await approveQuote(created.quoteId, owner, { post, now: NOW })).ok, true);

    const photos = (await getQuote(TEST_ORG, created.quoteId))!.attachments;
    assert.deepEqual(photos.map((p) => p.name), ["front.jpg", "back.jpg", "side.jpg"]);
    const revised = await reviseQuote({ quoteId: created.quoteId, removePhotoIds: [photos[1].id] }, owner, {
      post,
      now: NOW,
      photosSince: since,
    });
    assert.equal(revised.revisionNumber, 2);
    assert.equal(revised.status, "draft", "a changed approved quote needs approving again");
    assert.equal(await pages(), 2, "two photos left, on one page");
    assert.deepEqual((await getQuote(TEST_ORG, created.quoteId))!.attachments.map((p) => p.name), ["front.jpg", "side.jpg"]);

    // The photo window still covers the removed photo's message, and it stays off.
    await reviseQuote({ quoteId: created.quoteId }, owner, { post, now: NOW, photosSince: since });
    assert.equal((await getQuote(TEST_ORG, created.quoteId))!.attachments.length, 2);

    await assert.rejects(
      reviseQuote({ quoteId: created.quoteId, removePhotoIds: [photos[1].id] }, owner, { post, now: NOW }),
      /PHOTO_NOT_FOUND/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

withTestDb("linkRecentAttachments links unlinked inbound attachments once", async () => {
  const { owner, windows } = await seed();
  const { post } = recorder();
  const created = await createQuote({ title: "A", lines: [{ itemId: windows.id, quantity: 20 }] }, owner, { post, now: NOW });
  const since = new Date(Date.now() - 60_000);
  await db().insert(messages).values([
    {
      id: "msg_a",
      orgId: TEST_ORG,
      memberId: owner.memberId,
      phoneE164: owner.phoneE164!,
      direction: "inbound",
      kind: "user",
      body: "photos",
      attachments: [
        { type: "image", url: "https://files.example/1.jpg", name: "1.jpg", mimeType: "image/jpeg" },
        { type: "image", url: "https://files.example/2.jpg" },
      ],
    },
    { id: "msg_b", orgId: TEST_ORG, memberId: owner.memberId, phoneE164: owner.phoneE164!, direction: "inbound", kind: "user", body: "no files" },
  ]);
  assert.equal(await linkRecentAttachments(TEST_ORG, created.quoteId, owner.memberId, since), 2);
  assert.equal(await linkRecentAttachments(TEST_ORG, created.quoteId, owner.memberId, since), 0);
  const detail = await getQuote(TEST_ORG, created.quoteId);
  assert.deepEqual(detail?.attachments.map((a) => a.url).sort(), ["https://files.example/1.jpg", "https://files.example/2.jpg"]);
});

function fakeSummary(overrides: Partial<QuoteSummary> = {}): QuoteSummary {
  return {
    quoteId: "quo_1",
    title: "4512 Palm Ave",
    status: "draft",
    revisionNumber: 1,
    state: "ready",
    reasons: [],
    totalCents: 39200,
    lines: [
      { itemId: "i1", name: "windows in/out", unitLabel: "window", quantity: 28, unitCents: 1200, taxable: true, source: "pricebook", totalCents: 33600 },
      { itemId: "i2", name: "screens", unitLabel: "screen", quantity: 28, unitCents: 200, taxable: true, source: "pricebook", totalCents: 5600 },
    ],
    ruleLines: [],
    minimumAppliedCents: 0,
    adjustmentCents: 0,
    taxCents: 0,
    pdfUrl: null,
    customerId: null,
    customerName: null,
    propertyAddress: null,
    createdBy: "Pat",
    updatedAt: NOW,
    customerLink: null,
    customerApproval: null,
    depositCents: null,
    ...overrides,
  };
}

test("quoteSummaryText puts the total, each item, the extras, and the next step on their own lines", () => {
  const withRule = fakeSummary({ ruleLines: [{ ruleId: "r1", label: "3rd story", cents: 5000 }] });
  for (const language of ["en", "es"] as const) {
    assert.equal(quoteSummaryText(withRule, language).split("\n").length, 5);
    assert.equal(quoteSummaryText(fakeSummary(), language).split("\n").length, 4);
  }
  const en = quoteSummaryText(withRule, "en").split("\n");
  assert.equal(en[0], "Quote for 4512 Palm Ave: $392");
  assert.equal(en[1], "28 × windows in/out @ $12 = $336");
  assert.equal(en[2], "28 × screens @ $2 = $56");
  assert.equal(en[3], "3rd story +$50");
  assert.equal(en[4], "Reply ok to approve, or tell me what to change.");
  const single = fakeSummary({
    totalCents: 15000,
    lines: [{ itemId: "i3", name: "gutters", unitLabel: "visit", quantity: 1, unitCents: 15000, taxable: true, source: "pricebook", totalCents: 15000 }],
  });
  assert.equal(quoteSummaryText(single, "en").split("\n")[1], "gutters $150");
  assert.match(quoteSummaryText(withRule, "es"), /^Cotización para 4512 Palm Ave: \$392\n/);
});

test("quoteSummaryText names what is missing and stays on one line per row", () => {
  const unpriced = fakeSummary({
    title: "Line\nBreak",
    state: "needs_owner",
    status: "needs_owner",
    reasons: ["unpriced:skylights"],
    lines: [
      { itemId: null, name: "skylights", unitLabel: "", quantity: 2, unitCents: null, taxable: true, source: "unpriced", totalCents: null },
    ],
    totalCents: 0,
    minimumAppliedCents: 15000,
    taxCents: 120,
  });
  const lines = quoteSummaryText(unpriced, "en").split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "Quote for Line Break: not priced yet");
  assert.equal(lines[1], "2 skylights, unpriced");
  assert.match(lines[3], /price for skylights/);
  assert.match(quoteSummaryText(fakeSummary({ status: "approved" }), "en"), /Forward the PDF/);
});

test("quoteSummaryText offers crew the owner hand-off instead of approval", () => {
  const withRule = fakeSummary({ ruleLines: [{ ruleId: "r1", label: "3rd story", cents: 5000 }] });
  for (const language of ["en", "es"] as const) {
    const crew = quoteSummaryText(withRule, language, "member").split("\n");
    assert.equal(crew.length, 5);
    assert.equal(quoteSummaryText(fakeSummary(), language, "member").split("\n").length, 4);
    assert.equal(crew[4] === quoteSummaryText(withRule, language, "owner").split("\n")[4], false);
  }
  assert.equal(
    quoteSummaryText(fakeSummary(), "en", "member").split("\n")[3],
    "I can send it to the owner for approval, or tell me what to change.",
  );
  assert.match(quoteSummaryText(fakeSummary(), "es", "member"), /enviarlo al dueño/);
  assert.doesNotMatch(quoteSummaryText(fakeSummary(), "en", "member"), /Reply ok/);
  // Owners and admins, and callers that pass no role, still see the approve prompt.
  assert.match(quoteSummaryText(fakeSummary(), "en", "admin"), /Reply ok to approve/);
  assert.match(quoteSummaryText(fakeSummary(), "en"), /Reply ok to approve/);
});
