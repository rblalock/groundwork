process.env.BLOB_FAKE = "1";

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { followups, messages, quotes } from "../schema/schema";
import { db } from "./db";
import { computeDueAt, dueNudges, hourlyTick, morningLineText, nudgeText, runHourlyTick } from "./followups";
import hourly from "../agents/assistant/agent/schedules/hourly";
import { setTransportForTests } from "./imessage";
import { addPhone, createMember, recordInbound, removeMember, type Caller } from "./members";
import type { Profile } from "./profile";
import { saveItems } from "./pricebook";
import {
  approveQuote,
  createQuote,
  requestOwnerApproval,
  reviseQuote,
  setQuoteOutcome,
  type Poster,
  type QuoteSummary,
} from "./quotes";
import { TEST_ORG, withTestDb } from "./test-db";

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
afterEach(() => setTransportForTests(null));

const quiet: Poster = async () => ({ posted: true });
const NY = { timeZone: "America/New_York", quietStartHour: 20, quietEndHour: 7 } as Profile;

async function person(name: string, role: Caller["role"], e164: string): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  const phone = await addPhone(TEST_ORG, member.id, e164);
  await recordInbound(TEST_ORG, phone.id, `thread:${e164}`, new Date());
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: e164 };
}

async function seedApproved(title = "4512 Palm Ave") {
  const owner = await person("Pat", "owner", "+13055550100");
  const [widget] = await saveItems(
    TEST_ORG,
    [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1400 }],
    owner.memberId,
  );
  const approvedAt = new Date("2026-10-20T15:00:00Z"); // 11:00 in New York
  const created = await createQuote({ title, lines: [{ itemId: widget.id, quantity: 28 }] }, owner, {
    post: quiet,
    now: approvedAt,
  });
  await approveQuote(created.quoteId, owner, { post: quiet, now: approvedAt });
  return { owner, widget, quoteId: created.quoteId };
}

const DUE = new Date("2026-10-23T15:00:00Z"); // three days later, 11:00 in New York

test("computeDueAt moves a 23:00 local due time to 07:00", () => {
  const from = new Date("2026-10-21T03:00:00Z"); // 23:00 in New York
  assert.equal(computeDueAt(from, 3, NY).toISOString(), "2026-10-24T11:00:00.000Z"); // 07:00 New York
  assert.equal(computeDueAt(new Date("2026-10-20T15:00:00Z"), 3, NY).toISOString(), "2026-10-23T15:00:00.000Z");
});

test("morningLineText is null when nothing is open and counts otherwise", () => {
  assert.equal(morningLineText({ waitingOnCustomers: 0, waitingOnOwner: 0, drafts: 0 }, "en"), null);
  assert.equal(
    morningLineText({ waitingOnCustomers: 2, waitingOnOwner: 1, drafts: 0 }, "en"),
    "Good morning. 2 quotes waiting on customers, 1 crew draft waiting on you.",
  );
  assert.equal(
    morningLineText({ waitingOnCustomers: 1, waitingOnOwner: 0, drafts: 3 }, "en"),
    "Good morning. 1 quote waiting on customers, 3 drafts in progress.",
  );
  assert.equal(
    morningLineText({ waitingOnCustomers: 2, waitingOnOwner: 1, drafts: 0 }, "es"),
    "Buenos días. 2 cotizaciones esperando a los clientes, 1 borrador del equipo esperando por ti.",
  );
});

test("nudgeText names the quote, total, and days in both languages", () => {
  const quote = { title: "4512 Palm Ave", totalCents: 39200 } as QuoteSummary;
  assert.equal(
    nudgeText(quote, "en", 3),
    "4512 Palm Ave ($392) was approved 3 days ago and I haven't heard how it went. Want me to draft a follow-up, or mark it won or lost?",
  );
  assert.match(nudgeText(quote, "en", 1), /approved 1 day ago/);
  assert.match(nudgeText(quote, "es", 3), /^4512 Palm Ave \(\$392\) fue aprobada hace 3 días/);
  assert.match(nudgeText(quote, "es", 1), /hace 1 día /);
});

withTestDb("runHourlyTick sends a due nudge once and schedules the weekly one", async () => {
  install();
  const { owner, quoteId } = await seedApproved();
  assert.equal((await dueNudges(TEST_ORG, new Date("2026-10-23T14:59:00Z"))).length, 0);
  const due = await dueNudges(TEST_ORG, DUE);
  assert.equal(due.length, 1);
  assert.equal(due[0].quote.title, "4512 Palm Ave");

  assert.deepEqual(await runHourlyTick(DUE), { nudges: 1, mornings: 0, notices: 0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^4512 Palm Ave \(\$392\) was approved 3 days ago/);
  assert.equal(sent[0].threadId, "thread:+13055550100");

  const rows = await db().select().from(followups).where(eq(followups.quoteId, quoteId));
  assert.deepEqual(rows.map((r) => r.status).sort(), ["pending", "sent"]);
  const next = rows.find((r) => r.status === "pending")!;
  assert.equal(next.dueAt.toISOString(), "2026-10-30T15:00:00.000Z");
  assert.equal(next.memberId, owner.memberId);

  const [log] = await db().select().from(messages).where(eq(messages.kind, "proactive"));
  assert.equal(log.quoteId, quoteId);
  assert.equal(log.asksApproval, true, "a 👍 on a nudge is an ok for its quote");

  assert.deepEqual(await runHourlyTick(DUE), { nudges: 0, mornings: 0, notices: 0 });
  assert.equal(sent.length, 1);
  const weekly = await runHourlyTick(new Date("2026-10-30T15:00:00Z"));
  assert.equal(weekly.nudges, 1);
  assert.match(sent[1].text, /approved 10 days ago/);
});

withTestDb("a nudge due in quiet hours stays pending and goes out at the next tick after 07:00", async () => {
  install();
  const { quoteId } = await seedApproved();
  const night = new Date("2026-10-24T03:00:00Z"); // 23:00 in New York
  assert.deepEqual(await runHourlyTick(night), { nudges: 0, mornings: 0, notices: 0 });
  assert.equal(sent.length, 0);
  const [row] = await db().select().from(followups).where(eq(followups.quoteId, quoteId));
  assert.equal(row.status, "pending");
  assert.deepEqual(await runHourlyTick(new Date("2026-10-24T11:00:00Z")), { nudges: 1, mornings: 0, notices: 0 });
});

withTestDb("runHourlyTick posts the morning line once per local day", async () => {
  install();
  await seedApproved();
  const eight = new Date("2026-10-21T12:00:00Z"); // 08:00 in New York
  assert.deepEqual(await runHourlyTick(new Date("2026-10-21T11:00:00Z")), { nudges: 0, mornings: 0, notices: 0 });
  assert.deepEqual(await runHourlyTick(eight), { nudges: 0, mornings: 1, notices: 0 });
  assert.deepEqual(await runHourlyTick(new Date("2026-10-21T12:30:00Z")), { nudges: 0, mornings: 0, notices: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Good morning. 1 quote waiting on customers.");
  // The next local day gets its own line.
  assert.equal((await runHourlyTick(new Date("2026-10-22T12:00:00Z"))).mornings, 1);
});

withTestDb("the morning line is silent on quiet days and counts the owner's queue", async () => {
  install();
  const owner = await person("Pat", "owner", "+13055550100");
  const crew = await person("Carlos", "member", "+13055550142");
  const eight = new Date("2026-10-21T12:00:00Z");
  assert.deepEqual(await runHourlyTick(eight), { nudges: 0, mornings: 0, notices: 0 });
  assert.equal(sent.length, 0);

  const [widget] = await saveItems(
    TEST_ORG,
    [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1400 }],
    owner.memberId,
  );
  const draft = await createQuote({ title: "Crew draft", lines: [{ itemId: widget.id, quantity: 5 }] }, crew, {
    post: quiet,
    now: eight,
  });
  await requestOwnerApproval(draft.quoteId, crew, { post: quiet });
  const next = new Date("2026-10-22T12:00:00Z");
  await runHourlyTick(next);
  const ownerLine = sent.find((s) => s.threadId === "thread:+13055550100");
  assert.equal(ownerLine?.text, "Good morning. 1 crew draft waiting on you.");
  const crewLine = sent.find((s) => s.threadId === "thread:+13055550142");
  assert.match(crewLine?.text ?? "", /^Good morning\. 1 draft/);
});

withTestDb("nudges for a quote marked won are cancelled", async () => {
  install();
  const { owner, quoteId } = await seedApproved();
  await setQuoteOutcome(quoteId, "won", owner, { now: DUE });
  assert.equal((await dueNudges(TEST_ORG, DUE)).length, 0);
  assert.deepEqual(await runHourlyTick(DUE), { nudges: 0, mornings: 0, notices: 0 });
  assert.equal(sent.length, 0);
  const [row] = await db().select().from(followups).where(eq(followups.quoteId, quoteId));
  assert.equal(row.status, "cancelled");
});

withTestDb("a removed member's nudge is cancelled, not retried", async () => {
  install();
  const { owner, quoteId } = await seedApproved();
  await person("Dana", "owner", "+13055550177"); // keep an active owner so removal is allowed
  await removeMember(TEST_ORG, owner.memberId);
  assert.deepEqual(await runHourlyTick(DUE), { nudges: 0, mornings: 0, notices: 0 });
  const [row] = await db().select().from(followups).where(eq(followups.quoteId, quoteId));
  assert.equal(row.status, "cancelled");
});

const heldByQuietHours: Poster = async () => ({ posted: false, reason: "quiet_hours" });
const NIGHT = new Date("2026-10-21T03:00:00Z"); // 23:00 in New York
const SEVEN = new Date("2026-10-21T11:00:00Z"); // 07:00 in New York

async function crewDraft() {
  const owner = await person("Pat", "owner", "+13055550100");
  const crew = await person("Carlos", "member", "+13055550142");
  const [widget] = await saveItems(
    TEST_ORG,
    [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1400 }],
    owner.memberId,
  );
  const draft = await createQuote({ title: "12 Elm St", lines: [{ itemId: widget.id, quantity: 5 }] }, crew, {
    post: quiet,
    now: NIGHT,
  });
  return { owner, crew, quoteId: draft.quoteId };
}

withTestDb("a crew-draft notice held by quiet hours is queued and goes out at 07:00 asking for approval", async () => {
  install();
  const { owner, crew, quoteId } = await crewDraft();
  const result = await requestOwnerApproval(quoteId, crew, { post: heldByQuietHours, now: NIGHT });
  assert.deepEqual(result, { notified: [], queued: ["Pat"] });
  const [queued] = await db().select().from(followups).where(eq(followups.kind, "notice"));
  assert.equal(queued.memberId, owner.memberId);
  assert.equal(queued.quoteId, quoteId);
  assert.equal(queued.status, "pending");
  assert.equal(queued.dueAt.toISOString(), SEVEN.toISOString());
  assert.match(queued.payload?.text ?? "", /^Carlos drafted \$70 for 12 Elm St/);

  assert.deepEqual(await runHourlyTick(new Date("2026-10-21T10:00:00Z")), { nudges: 0, mornings: 0, notices: 0 });
  assert.deepEqual(await runHourlyTick(SEVEN), { nudges: 0, mornings: 0, notices: 1 });
  assert.deepEqual(sent, [{ threadId: "thread:+13055550100", text: queued.payload?.text }]);
  const [log] = await db().select().from(messages).where(eq(messages.kind, "proactive"));
  assert.equal(log.quoteId, quoteId);
  assert.equal(log.asksApproval, true);
  assert.equal((await db().select().from(followups).where(eq(followups.id, queued.id)))[0].status, "sent");
  assert.equal((await runHourlyTick(SEVEN)).notices, 0, "sent once");
});

withTestDb("an approval notice held by quiet hours reaches the crew member in the morning", async () => {
  install();
  const { owner, crew, quoteId } = await crewDraft();
  await requestOwnerApproval(quoteId, crew, { post: quiet, now: NIGHT });
  await approveQuote(quoteId, owner, { post: heldByQuietHours, now: NIGHT });
  const [queued] = await db().select().from(followups).where(eq(followups.kind, "notice"));
  assert.equal(queued.memberId, crew.memberId);
  assert.equal(queued.payload?.asksApproval, false);
  assert.equal((await runHourlyTick(SEVEN)).notices, 1);
  assert.match(sent[0].text, /^Pat approved 12 Elm St/);
  assert.equal(sent[0].threadId, "thread:+13055550142");
});

withTestDb("a queued crew-draft notice is dropped once the quote is no longer waiting", async () => {
  install();
  const { owner, crew, quoteId } = await crewDraft();
  await requestOwnerApproval(quoteId, crew, { post: heldByQuietHours, now: NIGHT });
  await approveQuote(quoteId, owner, { post: quiet, now: NIGHT }); // an admin got to it first
  assert.equal((await runHourlyTick(SEVEN)).notices, 0);
  assert.equal(sent.length, 0);
  const [row] = await db().select().from(followups).where(eq(followups.kind, "notice"));
  assert.equal(row.status, "cancelled");
});

withTestDb("a queued crew-draft notice is dropped when the quote is revised before morning", async () => {
  install();
  const { crew, quoteId } = await crewDraft();
  await requestOwnerApproval(quoteId, crew, { post: heldByQuietHours, now: NIGHT });
  // Revised overnight: a 👍 on the morning notice would approve a price the owner never saw.
  await reviseQuote({ quoteId, customerNotes: "Gate code 1234" }, crew, { post: quiet, now: NIGHT });
  assert.equal((await runHourlyTick(SEVEN)).notices, 0);
  assert.equal(sent.length, 0);
  const [row] = await db().select().from(followups).where(eq(followups.kind, "notice"));
  assert.equal(row.status, "cancelled");
});

withTestDb("asking twice in quiet hours queues one notice per owner", async () => {
  install();
  const { crew, quoteId } = await crewDraft();
  await requestOwnerApproval(quoteId, crew, { post: heldByQuietHours, now: NIGHT });
  await requestOwnerApproval(quoteId, crew, { post: heldByQuietHours, now: NIGHT });
  const rows = await db().select().from(followups).where(eq(followups.kind, "notice"));
  assert.deepEqual(rows.map((r) => r.status).sort(), ["cancelled", "pending"]);
});

withTestDb("an owner who can't be texted is neither notified nor queued", async () => {
  install();
  const { crew, quoteId } = await crewDraft();
  const neverTexted: Poster = async () => ({ posted: false, reason: "never_texted" });
  assert.deepEqual(await requestOwnerApproval(quoteId, crew, { post: neverTexted, now: NIGHT }), { notified: [], queued: [] });
  assert.equal((await db().select().from(followups).where(eq(followups.kind, "notice"))).length, 0);
});

function captureErrors() {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  return { errors, restore: () => (console.error = original) };
}

withTestDb("one nudge whose quote can't be summarized doesn't stop the others", async () => {
  install();
  const { owner, quoteId } = await seedApproved();
  // An approved quote with no current revision: loadSummary throws for it.
  await db().insert(quotes).values({ id: "quo_broken", orgId: TEST_ORG, title: "Broken", status: "approved", createdByMemberId: owner.memberId });
  await db().insert(followups).values({ id: "fu_broken", orgId: TEST_ORG, quoteId: "quo_broken", memberId: owner.memberId, kind: "nudge", dueAt: new Date("2026-10-22T15:00:00Z") });
  const { errors, restore } = captureErrors();
  try {
    assert.deepEqual((await dueNudges(TEST_ORG, DUE)).map((d) => d.quoteId), [quoteId]);
    assert.equal((await runHourlyTick(DUE)).nudges, 1);
  } finally {
    restore();
  }
  assert.ok(errors.length >= 1);
  assert.match(sent[0].text, /^4512 Palm Ave/);
});

test("a failed hourly tick is logged, not left rejected", async () => {
  const { errors, restore } = captureErrors();
  try {
    await hourlyTick(new Date(), async () => Promise.reject(new Error("db down")));
  } finally {
    restore();
  }
  assert.equal(errors.length, 1);
  assert.match(String((errors[0][1] as Error).message), /db down/);
});

withTestDb("the hourly schedule hands eve a tick that settles", async () => {
  const pending: Promise<unknown>[] = [];
  await hourly.run({ waitUntil: (promise: Promise<unknown>) => void pending.push(promise) } as never);
  assert.equal(pending.length, 1);
  await pending[0];
});
