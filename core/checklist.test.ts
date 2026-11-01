// The crew's priced photos are stored in a temp folder as file:// URLs, as they would be in local dev.
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BLOB_LOCAL_DIR = mkdtempSync(join(tmpdir(), "checklist-blobs-"));

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { pricedPhotos, quoteAttachments } from "../schema/schema";
import type { PricedRegion } from "../schema/types";
import { checklistCounts, checklistFor, checklistText, ensureChecklist, itemsFromLines, itemText, outlinesOf, tickChecklist, visitToComplete } from "./checklist";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { assignPricedPhoto } from "./priced-photo";
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
  // Several photos: their regions together, and a line any of them locates is located.
  const second = [
    { lineIndex: 0, located: false },
    { lineIndex: 1, located: true },
  ];
  assert.deepEqual(
    itemsFromLines(lines, [...regions, ...second]).map((item) => item.located),
    [true, true, false],
  );
});

test("with several priced photos, an item says which photos outline it", () => {
  const photos = [
    { regions: [{ lineIndex: 0, located: true }, { lineIndex: 1, located: false }] },
    { regions: [{ lineIndex: 0, located: false }, { lineIndex: 1, located: true }] },
    { regions: [{ lineIndex: 0, located: true }, { lineIndex: 1, located: false }] },
  ] as unknown as Parameters<typeof outlinesOf>[0];
  const outlines = outlinesOf(photos);
  const mulch = { lineIndex: 0, name: "Mulch installed", quantity: 3, unitLabel: "cubic yard", located: true };
  const hedge = { lineIndex: 1, name: "Hedge trimming", quantity: 150, unitLabel: "cubic foot", located: true };
  assert.equal(itemText(mulch, "en", outlines), "Mulch installed, 3 cubic yards (outlined in photos 1 and 3)");
  assert.equal(itemText(hedge, "en", outlines), "Hedge trimming, 150 cubic feet (outlined in photo 2)");
  assert.equal(itemText(mulch, "es", outlines), "Mulch installed, 3 cubic yards (marcada en las fotos 1 y 3)");
  assert.equal(itemText({ ...hedge, quantity: 1, unitLabel: "hedge" }, "es", outlines), "Hedge trimming, 1 hedge (marcada en la foto 2)");
  // One photo says "the photo"; an item no photo shows now, though it was outlined, says "the photos".
  assert.equal(itemText(mulch, "en", outlinesOf(photos.slice(0, 1))), "Mulch installed, 3 cubic yards (outlined in the photo)");
  assert.equal(itemText({ ...mulch, lineIndex: 2 }, "en", outlines), "Mulch installed, 3 cubic yards (outlined in the photos)");
  const edging = { lineIndex: 2, name: "Bed edging", quantity: 40, unitLabel: "linear foot", located: false, doneAt: null };
  assert.equal(
    checklistText([{ ...mulch, doneAt: null }, edging], "en", outlines),
    "1. Mulch installed, 3 cubic yards (outlined in photos 1 and 3)\n2. Bed edging, 40 linear feet",
  );
  // Every item outlined somewhere: with several photos, which ones still tells the crew where to look.
  assert.equal(
    checklistText([{ ...mulch, doneAt: null }, { ...hedge, doneAt: new Date() }], "en", outlines),
    "1. Mulch installed, 3 cubic yards (outlined in photos 1 and 3)\n2. Hedge trimming, 150 cubic feet (outlined in photo 2) ✓",
  );
});

test("with several priced photos, an item in every photo or in none has no mark; the rest say which photos", () => {
  const regions = (...located: number[]) => ({ regions: [0, 1, 2, 3].map((lineIndex) => ({ lineIndex, located: located.includes(lineIndex) })) });
  // Five photos: the lawn in all of them, the big hedge in 1, 2 and 5, the small one in 2, the edging in 3 and 4.
  const photos = [regions(0, 1), regions(0, 1, 2), regions(0, 3), regions(0, 3), regions(0, 1)] as unknown as Parameters<typeof outlinesOf>[0];
  const items = [
    { lineIndex: 0, name: "Lawn mowing", quantity: 1, unitLabel: "visit", located: true, doneAt: null },
    { lineIndex: 1, name: "Hedge trimming", quantity: 360, unitLabel: "cubic foot", located: true, doneAt: null },
    { lineIndex: 2, name: "Hedge trimming", quantity: 112, unitLabel: "cubic foot", located: true, doneAt: null },
    { lineIndex: 3, name: "Bed edging", quantity: 220, unitLabel: "linear foot", located: true, doneAt: null },
    { lineIndex: 4, name: "Haul away", quantity: 1, unitLabel: "load", located: false, doneAt: null },
  ];
  assert.equal(
    checklistText(items, "en", outlinesOf(photos)),
    [
      "1. Lawn mowing, 1 visit",
      "2. Hedge trimming, 360 cubic feet (outlined in photos 1, 2 and 5)",
      "3. Hedge trimming, 112 cubic feet (outlined in photo 2)",
      "4. Bed edging, 220 linear feet (outlined in photos 3 and 4)",
      "5. Haul away, 1 load",
    ].join("\n"),
  );
  const spanish = [
    ["Corte de césped", "visita"],
    ["Poda de seto", "pie"],
    ["Poda de seto", "pie"],
    ["Bordeado", "pie"],
    ["Retiro", "carga"],
  ];
  assert.equal(
    checklistText(
      items.map((item, i) => ({ ...item, name: spanish[i][0], unitLabel: spanish[i][1] })),
      "es",
      outlinesOf(photos),
    ),
    [
      "1. Corte de césped, 1 visita",
      "2. Poda de seto, 360 pies (marcada en las fotos 1, 2 y 5)",
      "3. Poda de seto, 112 pies (marcada en la foto 2)",
      "4. Bordeado, 220 pies (marcada en las fotos 3 y 4)",
      "5. Retiro, 1 carga",
    ].join("\n"),
  );
  // The photos decide, not a flag left from before they changed.
  assert.equal(checklistText([{ ...items[4], lineIndex: 3, located: false }], "en", outlinesOf(photos)), "1. Haul away, 1 load (outlined in photos 3 and 4)");
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
  const files = [...(payload.file ? [payload.file] : []), ...(payload.files ?? []).map((f) => f.file)];
  posts.push({ memberId, text: payload.text ?? "", file: files.length ? files.map((f) => `${f.filename} ${f.mimeType}`).join(", ") : null });
  return { posted: true };
};

async function person(name: string, role: Caller["role"], phone: string): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  const row = await addPhone(TEST_ORG, member.id, phone);
  await recordInbound(TEST_ORG, row.id, `thread:${phone}`, new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: phone };
}

/**
 * Pat, Carlos, and Maria's won quote for mulch and edging, with a priced photo that found the mulch; with
 * `secondPhoto`, a photo of the back attached after it, priced too, that found the mulch as well.
 */
async function seed(options: { secondPhoto?: boolean } = {}) {
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
  if (options.secondPhoto) {
    // The same yard under another name: a photo's priced copy is one per stored photo.
    const back = join(mkdtempSync(join(tmpdir(), "checklist-")), "yard-back.jpg");
    copyFileSync(fileURLToPath(YARD), back);
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 18, 12, 0, seconds));
    await db()
      .insert(quoteAttachments)
      .values([
        { id: "qa_test", orgId: TEST_ORG, quoteId: quote.quoteId, uploadedByMemberId: pat.memberId, url: YARD, name: "yard-front.jpg", mimeType: "image/jpeg", createdAt: at(0) },
        { id: "qa_back", orgId: TEST_ORG, quoteId: quote.quoteId, uploadedByMemberId: pat.memberId, url: pathToFileURL(back).href, name: "yard-back.jpg", mimeType: "image/jpeg", createdAt: at(1) },
      ]);
    await db()
      .insert(pricedPhotos)
      .values({
        id: "pp_back",
        orgId: TEST_ORG,
        quoteId: quote.quoteId,
        revisionNumber: 1,
        sourceKind: "quote_attachment",
        sourceId: "qa_back",
        sourceUrl: pathToFileURL(back).href,
        url: "file:///priced-back.png",
        width: 800,
        height: 600,
        regions: [region(0, "Mulch installed", 3, "cubic yard", true), region(1, "Bed edging", 40, "linear foot", false)],
      });
  }
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
      file: "priced-photo.jpg image/jpeg",
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

withTestDb("with several priced photos, booked crew get each one in order, and an item every photo shows needs no photo number", async () => {
  const s = await seed({ secondPhoto: true });
  const booked = await bookVisit(s.pat, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "today", time: "09:00" }, { now: MONDAY_7AM, post });
  assert.deepEqual(posts, [
    {
      memberId: s.carlos.memberId,
      text: "Pat Ortega booked you for 412 Oak St: Mon, Oct 19, 9 AM–10 AM.\n\n1. Mulch installed, 3 cubic yards\n2. Bed edging, 40 linear feet",
      file: "priced-photo-1.jpg image/jpeg, priced-photo-2.jpg image/jpeg",
    },
  ]);
  const items = await checklistFor(TEST_ORG, booked.visit.jobId);
  assert.deepEqual(items.map((item) => item.located), [true, false]);
});

withTestDb("pricing the photos again marks the items not ticked yet, and leaves ticked ones, names, and quantities alone", async () => {
  const s = await seed({ secondPhoto: true });
  const booked = await bookVisit(s.pat, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "today", time: "09:00" }, { now: MONDAY_7AM, post });
  const { jobId } = booked.visit;
  const before = await checklistFor(TEST_ORG, jobId);
  assert.deepEqual(before.map((item) => item.located), [true, false]);
  await tickChecklist(s.carlos, { jobId, itemIds: [before[0].itemId] }, { now: MONDAY_11AM, post });

  // On the back photo, the edging is outlined now and the mulch is not.
  const edge = { id: "cand_edge", phrase: "bed edge", box: { left: 10, top: 10, right: 200, bottom: 60 }, areaPx: 5000, confidence: 0.9, svgPath: "M10 10L200 10L200 60L10 60Z" };
  await db().update(pricedPhotos).set({ candidates: [edge] }).where(eq(pricedPhotos.id, "pp_back"));
  await assignPricedPhoto(s.pat, s.quote.quoteId, "pp_back", [{ candidateId: edge.id, lineIndexes: [1] }]);
  // And on the front, nothing: the mulch is in no photo now, but its item was ticked.
  await assignPricedPhoto(s.pat, s.quote.quoteId, "pp_test", []);
  const after = await checklistFor(TEST_ORG, jobId);
  assert.deepEqual(
    after.map((item) => [item.name, item.quantity, item.located, Boolean(item.doneAt)]),
    [
      ["Mulch installed", 3, true, true],
      ["Bed edging", 40, true, false],
    ],
  );
  assert.deepEqual(after.map((item) => item.itemId), before.map((item) => item.itemId), "no item made or taken away");

  // Unticked, the mulch follows the photos the next time they change.
  await tickChecklist(s.carlos, { jobId, itemIds: [before[0].itemId], undo: true }, { now: MONDAY_11AM, post });
  await assignPricedPhoto(s.pat, s.quote.quoteId, "pp_back", []);
  assert.deepEqual((await checklistFor(TEST_ORG, jobId)).map((item) => item.located), [false, false]);
});

withTestDb("through the fake iMessage transport, booked crew see the list's text, then each priced photo on its own", async () => {
  const s = await seed({ secondPhoto: true });
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  try {
    await bookVisit(s.pat, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "today", time: "09:00" }, { now: MONDAY_7AM });
  } finally {
    console.log = log;
  }
  const sent = printed.filter((line) => line.startsWith("imessage (fake)")).map((line) => line.replace(/\(\d+ bytes\)/, "(N bytes)"));
  if (process.env.SHOW_FAKE_IMESSAGE) log(sent.join("\n"));
  assert.deepEqual(sent, [
    "imessage (fake) to thread:+15555550102: Pat Ortega booked you for 412 Oak St: Mon, Oct 19, 9 AM–10 AM.\n\n1. Mulch installed, 3 cubic yards\n2. Bed edging, 40 linear feet",
    "imessage (fake) file to thread:+15555550102: priced-photo-1.jpg (N bytes)",
    "imessage (fake) file to thread:+15555550102: priced-photo-2.jpg (N bytes)",
  ]);
});
