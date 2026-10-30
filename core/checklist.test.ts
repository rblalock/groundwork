import assert from "node:assert/strict";
import { test } from "node:test";
import { pricedPhotos } from "../schema/schema";
import type { PricedRegion } from "../schema/types";
import { checklistCounts, checklistFor, checklistText, ensureChecklist, itemsFromLines, itemText, tickChecklist, visitToComplete } from "./checklist";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { addPhone, createMember, recordInbound, type Caller } from "./members";
import { saveItems } from "./pricebook";
import { updateProfile } from "./profile";
import { approveQuote, createQuote, setQuoteOutcome, type Poster } from "./quotes";
import { bookVisit, getVisit, readSchedule, visitForTool } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

const NY = "America/New_York";
const YARD = new URL("../agents/assistant/evals/fixtures/yard-front.jpg", import.meta.url).href;

test("items follow the quote's lines in order, located only where the photo's region for that line is", () => {
  const lines = [
    { name: "Mulch installed", quantity: 3, unitLabel: "cubic yard" },
    { name: "Hedge trimming", quantity: 1, unitLabel: "hedge" },
    { name: "Bed edging", quantity: 40, unitLabel: "linear foot" },
  ];
  const regions = [
    { lineIndex: 0, located: true },
    { lineIndex: 1, located: false },
  ];
  assert.deepEqual(itemsFromLines(lines, regions), [
    { lineIndex: 0, name: "Mulch installed", quantity: 3, unitLabel: "cubic yard", located: true },
    { lineIndex: 1, name: "Hedge trimming", quantity: 1, unitLabel: "hedge", located: false },
    { lineIndex: 2, name: "Bed edging", quantity: 40, unitLabel: "linear foot", located: false },
  ]);
  assert.ok(itemsFromLines(lines, []).every((item) => !item.located), "no priced photo: nothing located");
});

test("item text is the line's name, quantity, and unit, in the reader's language, and never a price", () => {
  const mulch = { name: "Mulch installed", quantity: 3, unitLabel: "cubic yard", located: true };
  assert.equal(itemText(mulch, "en"), "Mulch installed, 3 cubic yards (outlined in the photo)");
  assert.equal(itemText(mulch, "es"), "Mulch installed, 3 cubic yards (marcada en la foto)");
  assert.equal(itemText({ name: "Hedge  trimming", quantity: 1, unitLabel: "hedge", located: false }, "en"), "Hedge trimming, 1 hedge");
  assert.equal(itemText({ name: "Haul away", quantity: 2.5, unitLabel: "", located: false }, "en"), "Haul away, 2.5");
  assert.equal(itemText({ name: "Seed", quantity: 1 / 3, unitLabel: "bag", located: false }, "en"), "Seed, 0.33 bags");
});

test("the list's lines are numbered and mark what's done", () => {
  const items = [
    { name: "Mulch installed", quantity: 3, unitLabel: "cubic yard", located: true, doneAt: new Date() },
    { name: "Bed edging", quantity: 40, unitLabel: "linear foot", located: false, doneAt: null },
  ];
  assert.equal(checklistText(items, "en"), "1. Mulch installed, 3 cubic yards (outlined in the photo) ✓\n2. Bed edging, 40 linear feet");
  assert.deepEqual(checklistCounts(items), { done: 1, total: 2 });
  // Every item outlined: the mark tells nothing apart, so it's left off.
  assert.equal(checklistText(items.map((item) => ({ ...item, located: true })), "en"), "1. Mulch installed, 3 cubic yards ✓\n2. Bed edging, 40 linear feet");
});

test("a finished list completes the latest open visit from today or earlier, never one on a later day", () => {
  // Monday, Oct 19, 2026, 6 PM in New York.
  const now = new Date("2026-10-19T22:00:00Z");
  const visit = (visitId: string, iso: string, status: "scheduled" | "proposed" | "completed" | "cancelled" = "scheduled") => ({ visitId, startAt: new Date(iso), status });
  assert.equal(visitToComplete([visit("tue", "2026-10-20T13:00:00Z")], now, NY), null, "tomorrow's visit stays open");
  assert.equal(visitToComplete([visit("mon", "2026-10-19T13:00:00Z"), visit("tue", "2026-10-20T13:00:00Z")], now, NY), "mon");
  assert.equal(visitToComplete([visit("fri", "2026-10-16T13:00:00Z"), visit("mon", "2026-10-19T13:00:00Z")], now, NY), "mon", "today's over a missed one");
  assert.equal(visitToComplete([visit("fri", "2026-10-16T13:00:00Z")], now, NY), "fri", "a missed visit, when that's all there is");
  // Later today still counts: it's today's visit.
  assert.equal(visitToComplete([visit("tonight", "2026-10-19T23:30:00Z")], now, NY), "tonight");
  assert.equal(visitToComplete([visit("mon", "2026-10-19T13:00:00Z", "completed"), visit("sun", "2026-10-18T13:00:00Z", "cancelled")], now, NY), null);
  assert.equal(visitToComplete([visit("mon", "2026-10-19T13:00:00Z", "proposed")], now, NY), "mon");
});

// ---------------------------------------------------------------------------------------------
// With the database

/** Monday, Oct 19, 2026, 7 AM in New York. */
const MONDAY_7AM = new Date("2026-10-19T11:00:00Z");
/** Monday, 11 AM: after the 9 AM visit. */
const MONDAY_11AM = new Date("2026-10-19T15:00:00Z");

let posts: Array<{ memberId: string; text: string; file: string | null }> = [];
const post: Poster = async (_orgId, memberId, payload) => {
  posts.push({ memberId, text: payload.text ?? "", file: payload.file ? `${payload.file.filename} ${payload.file.mimeType}` : null });
  return { posted: true };
};

async function person(name: string, role: Caller["role"], phone: string): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  const row = await addPhone(TEST_ORG, member.id, phone);
  await recordInbound(TEST_ORG, row.id, `thread:${phone}`, new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: phone };
}

/** Pat, Carlos, and Maria's won quote for mulch and edging, with a priced photo that found the mulch. */
async function seed() {
  posts = [];
  const pat = await person("Pat Ortega", "owner", "+15555550101");
  const carlos = await person("Carlos Reyes", "member", "+15555550102");
  await updateProfile(TEST_ORG, { timeZone: NY, quietStartHour: 22, quietEndHour: 5 }, pat.memberId);
  const [mulch, edging] = await saveItems(
    TEST_ORG,
    [
      { name: "Mulch installed", unitKind: "other", unitLabel: "cubic yard", priceCents: 9500 },
      { name: "Bed edging", unitKind: "linear_ft", unitLabel: "linear foot", priceCents: 250 },
    ],
    pat.memberId,
  );
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "412 Oak St" }, pat.memberId);
  const quote = await createQuote(
    {
      title: "412 Oak St",
      customerId: maria.id,
      propertyId: maria.properties[0].id,
      lines: [
        { itemId: mulch.id, quantity: 3 },
        { itemId: edging.id, quantity: 40 },
      ],
    },
    pat,
    { post },
  );
  await approveQuote(quote.quoteId, pat, { post });
  await setQuoteOutcome(quote.quoteId, "won", pat, { post });
  const region = (lineIndex: number, name: string, quantity: number, unitLabel: string, located: boolean): PricedRegion => ({
    lineIndex,
    itemId: null,
    name,
    quantity,
    unitLabel,
    totalCents: 1000,
    phrase: null,
    objects: [],
    located,
  });
  await db()
    .insert(pricedPhotos)
    .values({
      id: "pp_test",
      orgId: TEST_ORG,
      quoteId: quote.quoteId,
      revisionNumber: 1,
      sourceKind: "quote_attachment",
      sourceId: "qa_test",
      sourceUrl: YARD,
      url: "file:///priced-with-prices.png",
      width: 800,
      height: 600,
      regions: [region(0, "Mulch installed", 3, "cubic yard", true), region(1, "Bed edging", 40, "linear foot", false)],
    });
  posts = [];
  return { pat, carlos, quote };
}

withTestDb("booked crew get the checklist and the priced photo, and the last tick marks today's visit done", async () => {
  const s = await seed();
  const booked = await bookVisit(s.pat, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "today", time: "09:00" }, { now: MONDAY_7AM, post });
  assert.deepEqual(posts, [
    {
      memberId: s.carlos.memberId,
      text: "Pat Ortega booked you for 412 Oak St: Mon, Oct 19, 9 AM–10 AM.\n\n1. Mulch installed, 3 cubic yards (outlined in the photo)\n2. Bed edging, 40 linear feet",
      file: "priced-photo.png image/png",
    },
  ]);
  assert.doesNotMatch(posts[0].text, /\$/, "no prices to the crew");
  assert.deepEqual(booked.visit.checklist, { done: 0, total: 2 });
  const { jobId } = booked.visit;
  const items = await checklistFor(TEST_ORG, jobId);
  assert.equal((await ensureChecklist(TEST_ORG, jobId)).length, 2, "made once, at the booking");
  assert.deepEqual(items.map((item) => item.located), [true, false]);

  const deps = { now: MONDAY_11AM, post };
  const first = await tickChecklist(s.carlos, { jobId, itemIds: [items[0].itemId] }, deps);
  assert.equal(first.allDone, false);
  assert.equal(first.visitCompleted, null);
  assert.equal(first.items[0].doneByName, "Carlos Reyes");
  const schedule = await readSchedule(s.carlos, { from: "today", days: 1 }, { now: MONDAY_11AM });
  assert.deepEqual(visitForTool(schedule.visits[0], NY, "en").checklist, { done: 1, total: 2 });

  // Pat ticks both: the first keeps Carlos as who did it.
  const last = await tickChecklist(s.pat, { jobId, itemIds: items.map((item) => item.itemId) }, deps);
  assert.equal(last.allDone, true);
  assert.equal(last.visitCompleted?.visitId, booked.visit.visitId);
  assert.equal(last.visitCompleted?.status, "completed");
  assert.equal(last.openVisitsOnJob, 0);
  assert.deepEqual(last.items.map((item) => item.doneByName), ["Carlos Reyes", "Pat Ortega"]);

  // Unticking and ticking again doesn't reopen or complete anything.
  const undone = await tickChecklist(s.carlos, { jobId, itemIds: [items[1].itemId], undo: true }, deps);
  assert.equal(undone.allDone, false);
  assert.equal(undone.items[1].doneAt, null);
  assert.equal((await getVisit(s.pat, booked.visit.visitId))?.status, "completed");
  const again = await tickChecklist(s.carlos, { jobId, itemIds: [items[1].itemId] }, deps);
  assert.equal(again.allDone, true);
  assert.equal(again.visitCompleted, null, "no open visit left to mark done");

  await assert.rejects(tickChecklist(s.carlos, { jobId, itemIds: ["chk_nope"] }, deps), /CHECKLIST_ITEM_NOT_FOUND/);
  await assert.rejects(tickChecklist(s.carlos, { jobId: "sj_nope", itemIds: [items[0].itemId] }, deps), /SERVICE_JOB_NOT_FOUND/);
});

withTestDb("a finished list never marks a visit on a later day done", async () => {
  const s = await seed();
  const booked = await bookVisit(s.pat, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tomorrow", time: "09:00" }, { now: MONDAY_7AM, post });
  const items = await checklistFor(TEST_ORG, booked.visit.jobId);
  const done = await tickChecklist(s.carlos, { jobId: booked.visit.jobId, itemIds: items.map((item) => item.itemId) }, { now: MONDAY_11AM, post });
  assert.equal(done.allDone, true);
  assert.equal(done.visitCompleted, null);
  assert.equal((await getVisit(s.pat, booked.visit.visitId))?.status, "scheduled");
});
