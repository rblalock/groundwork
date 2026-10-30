import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { events, visitRevisions } from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { runOrgTick } from "./followups";
import { setTransportForTests } from "./imessage";
import { addPhone, createMember, recordInbound, type Caller } from "./members";
import { driveMinutes, yardOf } from "./places";
import { findItemByName, saveItems, updateItem } from "./pricebook";
import { updateTeamMember } from "./team";
import findAvailabilityTool from "../agents/assistant/agent/tools/find_availability";
import type { z } from "zod";
import { getProfile, updateProfile } from "./profile";
import { approveQuote, createQuote, setQuoteOutcome, type Poster } from "./quotes";
import {
  addTimeOff,
  bookVisit,
  changeVisitStatus,
  closeServiceJob,
  createServiceJob,
  findAvailability,
  fitsCapacity,
  getServiceJob,
  rankSlots,
  readSchedule,
  removeTimeOff,
  rescheduleVisit,
  serviceJobsAbout,
  setWorkHours,
  slotLine,
  slotLines,
  toSchedule,
  visitForTool,
} from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

const NY = "America/New_York";
/** Monday, Oct 19, 2026, 8 AM in New York. */
const MONDAY_8AM = new Date("2026-10-19T12:00:00Z");

let texts: Array<{ memberId: string; text: string }> = [];
const post: Poster = async (_orgId, memberId, payload) => {
  texts.push({ memberId, text: payload.text ?? "" });
  return { posted: true };
};
afterEach(() => setTransportForTests(null));

async function person(name: string, role: Caller["role"], phone: string): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  const row = await addPhone(TEST_ORG, member.id, phone);
  await recordInbound(TEST_ORG, row.id, `thread:${phone}`, new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: phone };
}

/** An owner, two crew, and a quote the customer said yes to. */
async function seed() {
  texts = [];
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const carlos = await person("Carlos Crew", "member", "+15555550102");
  const ana = await person("Ana Crew", "member", "+15555550103");
  await updateProfile(TEST_ORG, { timeZone: NY }, owner.memberId);
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const customer = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "12 Oak St" }, owner.memberId);
  const quote = await createQuote(
    { title: "12 Oak St", customerId: customer.id, propertyId: customer.properties[0].id, lines: [{ itemId: item.id, quantity: 10 }] },
    owner,
    { post },
  );
  await approveQuote(quote.quoteId, owner, { post });
  await setQuoteOutcome(quote.quoteId, "won", owner, { post });
  const draft = await createQuote({ title: "4 Elm Rd", lines: [{ itemId: item.id, quantity: 2 }] }, owner, { post });
  texts = [];
  return { owner, carlos, ana, customer, quote, draft };
}

const deps = { now: MONDAY_8AM, post };

withTestDb("a won quote is booked: one job, a visit at the local time, and the crew told", async () => {
  const s = await seed();
  assert.deepEqual((await toSchedule(TEST_ORG)).map((t) => t.kind === "quote" && t.quoteId), [s.quote.quoteId]);

  const booked = await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00" }, deps);
  assert.equal(booked.jobCreated, true);
  assert.equal(booked.visit.startAt.toISOString(), "2026-10-20T13:00:00.000Z");
  assert.equal(booked.visit.endAt.toISOString(), "2026-10-20T14:00:00.000Z", "an hour unless they say");
  assert.equal(booked.visit.title, "12 Oak St");
  assert.equal(booked.visit.customerName, "Ada Sample");
  assert.equal(booked.visit.status, "scheduled");
  assert.deepEqual(booked.visit.crew.map((c) => c.name), ["Carlos Crew"]);
  assert.deepEqual(texts, [{ memberId: s.carlos.memberId, text: "Pat Owner booked you for 12 Oak St: Tue, Oct 20, 9 AM–10 AM.\n\n1. widget service, 10 widgets" }]);
  assert.deepEqual(await toSchedule(TEST_ORG), []);

  // A second visit on the same quote goes on the same job; booking yourself sends you nothing.
  texts = [];
  const second = await bookVisit(
    s.owner,
    { quoteId: s.quote.quoteId, memberIds: [s.owner.memberId, s.ana.memberId], day: "2026-10-21", time: "13:30", durationMinutes: 90 },
    deps,
  );
  assert.equal(second.jobCreated, false);
  assert.equal(second.visit.jobId, booked.visit.jobId);
  assert.deepEqual(texts.map((t) => t.memberId), [s.ana.memberId]);
  const jobs = await serviceJobsAbout(s.owner, { quoteId: s.quote.quoteId });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].visits.length, 2);
  const [revision] = await db().select().from(visitRevisions).where(eq(visitRevisions.visitId, booked.visit.visitId));
  assert.equal(revision.action, "booked");

  // A draft can't be scheduled: its money isn't agreed.
  await assert.rejects(
    bookVisit(s.owner, { quoteId: s.draft.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "13:00" }, deps),
    /QUOTE_NOT_AGREED/,
  );
});

withTestDb("booking refuses the past, other visits, buffers, time off, and hours unless the owner means it", async () => {
  const s = await seed();
  const book = (input: Partial<Parameters<typeof bookVisit>[1]>) =>
    bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00", ...input }, deps);
  await book({ bufferAfterMinutes: 30 });

  await assert.rejects(book({ day: "today", time: "07:00" }), /VISIT_IN_PAST/);
  await assert.rejects(book({ time: "09:30" }), /CREW_BUSY: Carlos Crew has 12 Oak St Tue, Oct 20, 9 AM–10 AM/);
  await assert.rejects(book({ time: "10:15" }), /CREW_BUSY/, "inside the first visit's buffer");
  const other = await book({ time: "10:30" });
  assert.equal(other.visit.startAt.toISOString(), "2026-10-20T14:30:00.000Z");
  await book({ memberIds: [s.ana.memberId], time: "09:30" });

  await assert.rejects(book({ time: "16:30" }), /OUTSIDE_HOURS: Carlos Crew works 08:00-17:00 that day/);
  await assert.rejects(book({ day: "saturday" }), /OUTSIDE_HOURS: Carlos Crew works no hours that day/);
  const saturday = await book({ day: "saturday", allowOutsideHours: true });
  assert.equal(saturday.visit.startAt.toISOString(), "2026-10-24T13:00:00.000Z");

  await addTimeOff(s.carlos, { memberId: s.carlos.memberId, day: "thursday", reason: "dentist" }, deps);
  await assert.rejects(book({ day: "thursday" }), /CREW_OFF: Carlos Crew is off then \(dentist\)/);
  await assert.rejects(addTimeOff(s.owner, { memberId: s.carlos.memberId, day: "tuesday" }, deps), /HAS_VISITS: 12 Oak St/);
});

withTestDb("availability: working hours in 15-minute steps, around visits, buffers, and time off, for all the crew at once", async () => {
  const s = await seed();
  await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00", bufferAfterMinutes: 15 }, deps);
  await addTimeOff(s.owner, { memberId: s.ana.memberId, day: "tuesday", start: "13:00", end: "17:00" }, deps);

  const carlos = await findAvailability(s.owner, { memberIds: [s.carlos.memberId], from: "tuesday", days: 1, durationMinutes: 60 }, deps);
  const starts = carlos.slots.map((slot) => slot.start);
  assert.equal(starts[0], "08:00");
  assert.ok(!starts.includes("08:15"), "would run into the 9 AM visit");
  assert.ok(!starts.includes("09:00") && !starts.includes("10:00"), "the visit and its buffer");
  assert.ok(starts.includes("10:15"));
  assert.equal(starts.at(-1), "16:00");
  assert.ok(starts.every((t) => Number(t.slice(3)) % 15 === 0));

  const both = await findAvailability(s.owner, { memberIds: [s.carlos.memberId, s.ana.memberId], from: "tuesday", days: 1, durationMinutes: 60 }, deps);
  assert.deepEqual(
    both.slots.map((slot) => slot.start),
    ["08:00", "10:15", "10:30", "10:45", "11:00", "11:15", "11:30", "11:45", "12:00"],
  );

  // Today's slots start after now (8 AM), and a visit being moved doesn't block itself.
  const today = await findAvailability(s.owner, { memberIds: [s.ana.memberId], from: "today", days: 1 }, deps);
  assert.equal(today.slots[0].start, "08:15");
});

withTestDb("buffers are the drive: in from the yard or the stop before, out to the next stop or back, and unplaced falls back", async () => {
  const s = await seed();
  await updateProfile(TEST_ORG, { address: "100 Bridge Rd, Tequesta, FL" }, s.owner.memberId);
  const yard = yardOf(await getProfile(TEST_ORG))!;
  const oak = { lat: s.customer.properties[0].lat!, lng: s.customer.properties[0].lng! };
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "7 Pine Ave" }, s.owner.memberId);
  const pine = { lat: maria.properties[0].lat!, lng: maria.properties[0].lng! };
  assert.equal(driveMinutes(yard, oak), 10);

  // An empty day: the drive in from the yard and back both fit inside the crew's hours.
  const open = await findAvailability(s.owner, { memberIds: [s.carlos.memberId], from: "tuesday", days: 1, quoteId: s.quote.quoteId }, deps);
  assert.equal(open.driveEstimated, true);
  assert.equal(open.slots[0].start, "08:15", "leaving the yard at 8, there by 8:10");
  assert.equal(open.slots[0].driveFromPreviousMinutes, 10);
  assert.equal(open.slots.at(-1)!.start, "15:45", "back at the yard by 5");

  const first = await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00" }, deps);
  assert.equal(first.driveEstimated, true);
  assert.deepEqual([first.visit.bufferBeforeMinutes, first.visit.bufferAfterMinutes], [10, driveMinutes(oak, yard)]);
  assert.deepEqual(first.visit.drive?.fromPrevious, { minutes: 10, label: "100 Bridge Rd, Tequesta, FL", yard: true });
  assert.equal(texts.at(-1)?.text.split("\n")[0], "Pat Owner booked you for 12 Oak St: Tue, Oct 20, 9 AM–10 AM. About 10 min from the yard.");
  const tool = visitForTool(first.visit, NY, "en");
  assert.deepEqual([tool.driveFromPreviousMinutes, tool.driveFrom, tool.driveToNextMinutes], [10, "the yard", driveMinutes(oak, yard)]);

  const second = await bookVisit(
    s.owner,
    { title: "Pine Ave beds", customerId: maria.id, propertyId: maria.properties[0].id, memberIds: [s.carlos.memberId], day: "tuesday", time: "11:00" },
    deps,
  );
  assert.deepEqual([second.visit.bufferBeforeMinutes, second.visit.bufferAfterMinutes], [driveMinutes(oak, pine), driveMinutes(pine, yard)]);
  assert.ok(texts.at(-1)?.text.endsWith(`About ${driveMinutes(oak, pine)} min from 12 Oak St.`));

  // The schedule works drives out from the day as it is now: the first visit now goes on to Pine Ave.
  const day = await readSchedule(s.owner, { from: "tuesday", days: 1 }, deps);
  const firstNow = day.visits.find((v) => v.visitId === first.visit.visitId)!;
  assert.deepEqual(firstNow.drive?.toNext, { minutes: driveMinutes(oak, pine), label: "7 Pine Ave", yard: false });

  // A buffer the member gives wins over the drive.
  const given = await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "14:00", bufferBeforeMinutes: 30 }, deps);
  assert.equal(given.visit.bufferBeforeMinutes, 30);
  assert.equal(given.visit.bufferAfterMinutes, driveMinutes(oak, yard));

  // An address that couldn't be placed: no drive, today's default buffers, and the result says so.
  const nowhere = await saveCustomer(TEST_ORG, { name: "Bo Sample", address: "999 Nowhere Ln" }, s.owner.memberId);
  const guess = await findAvailability(s.owner, { memberIds: [s.ana.memberId], from: "tuesday", days: 1, propertyId: nowhere.properties[0].id }, deps);
  assert.equal(guess.driveEstimated, false);
  assert.equal(guess.slots[0].start, "08:00");
  const unplaced = await bookVisit(
    s.owner,
    { title: "Back lot", customerId: nowhere.id, propertyId: nowhere.properties[0].id, memberIds: [s.ana.memberId], day: "tuesday", time: "09:00" },
    deps,
  );
  assert.equal(unplaced.driveEstimated, false);
  assert.deepEqual([unplaced.visit.bufferBeforeMinutes, unplaced.visit.bufferAfterMinutes], [0, 0]);
  assert.deepEqual(unplaced.visit.drive, { fromPrevious: null, toNext: null });
  assert.equal(texts.at(-1)?.text, "Pat Owner booked you for Back lot: Tue, Oct 20, 9 AM–10 AM.");
  await assert.rejects(findAvailability(s.owner, { memberIds: [s.ana.memberId], from: "tuesday", propertyId: "prop_elsewhere" }, deps), /PROPERTY_NOT_FOUND/);
});

test("capacity: a day fits while its work and driving stay within the share of its working hours", () => {
  const day = { workMinutes: 300, driveMinutes: 40, dayMinutes: 540, capacityBp: 9500 };
  assert.equal(fitsCapacity(day, 173), true, "513 of 540 is exactly 95%");
  assert.equal(fitsCapacity(day, 174), false);
  assert.equal(fitsCapacity({ ...day, dayMinutes: 0 }, 0), false, "a day off fits nothing");
});

test("slots rank: those that fit first, then the least added driving (unknown last), then the earliest", () => {
  const at = (iso: string) => new Date(iso);
  const slots = [
    { id: "far-early", fits: true, addedDriveMinutes: 20, startAt: at("2026-11-03T13:00:00Z") },
    { id: "full", fits: false, addedDriveMinutes: 0, startAt: at("2026-11-03T12:00:00Z") },
    { id: "unknown", fits: true, addedDriveMinutes: null, startAt: at("2026-11-02T13:00:00Z") },
    { id: "near-late", fits: true, addedDriveMinutes: 5, startAt: at("2026-11-05T13:00:00Z") },
    { id: "near-later", fits: true, addedDriveMinutes: 5, startAt: at("2026-11-05T14:00:00Z") },
  ];
  assert.deepEqual(rankSlots(slots, true).map((s) => s.id), ["near-late", "near-later", "far-early", "unknown", "full"]);
  assert.deepEqual(rankSlots(slots, false).map((s) => s.id), ["unknown", "far-early", "near-late", "near-later", "full"], "unplaced: by time");
});

test("slot lines: when, who, the driving it adds, and a day over capacity, one per crew and day", () => {
  const carlos = { memberId: "mem_carlos", name: "Carlos Reyes" };
  const ana = { memberId: "mem_ana", name: "Ana Crew" };
  const slot = (start: string, crew = [carlos], extra: Partial<Parameters<typeof slotLine>[0]> = {}) => ({
    date: start.slice(0, 10),
    start: "",
    end: "",
    startAt: new Date(`${start}:00-05:00`),
    endAt: new Date(`${start}:00-05:00`),
    offsetMinutes: -300,
    crew,
    driveFromPreviousMinutes: null,
    driveToNextMinutes: null,
    driveEstimated: true,
    addedDriveMinutes: 10,
    fits: true,
    ...extra,
  });
  assert.equal(slotLine(slot("2026-11-03T09:00"), NY, "en"), "Tue, Nov 3, 9 AM with Carlos (+10 min driving)");
  assert.equal(
    slotLine(slot("2026-11-03T09:30", [carlos, ana], { fits: false }), NY, "en"),
    "Tue, Nov 3, 9:30 AM with Carlos and Ana (+10 min driving; day would be over capacity)",
  );
  assert.equal(slotLine(slot("2026-11-03T09:00", [carlos], { addedDriveMinutes: null }), NY, "en"), "Tue, Nov 3, 9 AM with Carlos");
  assert.match(slotLine(slot("2026-11-03T09:00"), NY, "es"), /con Carlos \(\+10 min de manejo\)$/);
  const lines = slotLines([slot("2026-11-03T09:00"), slot("2026-11-03T09:15"), slot("2026-11-03T09:00", [ana]), slot("2026-11-04T09:00"), slot("2026-11-05T09:00")], NY, "en");
  assert.deepEqual(lines, [
    "Tue, Nov 3, 9 AM with Carlos (+10 min driving)",
    "Tue, Nov 3, 9 AM with Ana (+10 min driving)",
    "Wed, Nov 4, 9 AM with Carlos (+10 min driving)",
  ]);
  // One crew asked about one day: the next-ranked slots fill in, a couple of hours apart.
  const oneDay = slotLines([slot("2026-11-03T09:00"), slot("2026-11-03T09:15"), slot("2026-11-03T11:00"), slot("2026-11-03T12:30"), slot("2026-11-03T14:00")], NY, "en");
  assert.deepEqual(oneDay, [
    "Tue, Nov 3, 9 AM with Carlos (+10 min driving)",
    "Tue, Nov 3, 11 AM with Carlos (+10 min driving)",
    "Tue, Nov 3, 2 PM with Carlos (+10 min driving)",
  ]);
});

withTestDb("slots fit the route: least added driving before a far day, under the day's capacity, and each member when nobody is named", async () => {
  const s = await seed();
  await updateProfile(TEST_ORG, { address: "100 Bridge Rd, Tequesta, FL" }, s.owner.memberId);
  const yard = yardOf(await getProfile(TEST_ORG))!;
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "7 Pine Ave" }, s.owner.memberId);
  const next = await saveCustomer(TEST_ORG, { name: "Bo Sample", address: "40 Pine Ave" }, s.owner.memberId);
  const pine = { lat: maria.properties[0].lat!, lng: maria.properties[0].lng! };
  const work = { lat: next.properties[0].lat!, lng: next.properties[0].lng! };
  // Wednesday Carlos is at 7 Pine Ave, next door to the work; Tuesday he's free.
  await bookVisit(s.owner, { title: "Pine Ave beds", customerId: maria.id, propertyId: maria.properties[0].id, memberIds: [s.carlos.memberId], day: "wednesday", time: "09:00" }, deps);

  const ask = () => findAvailability(s.owner, { memberIds: [s.carlos.memberId], from: "tuesday", days: 2, propertyId: next.properties[0].id }, deps);
  const ranked = await ask();
  const tuesday = ranked.slots.filter((slot) => slot.date === "2026-10-20");
  const wednesday = ranked.slots.filter((slot) => slot.date === "2026-10-21");
  assert.ok(tuesday.length && wednesday.length);
  assert.equal(ranked.slots[0].date, "2026-10-21", "the day already out that way comes first");
  assert.ok(tuesday.every((slot) => slot.addedDriveMinutes === driveMinutes(yard, work) + driveMinutes(work, yard)));
  const afterPine = wednesday.find((slot) => slot.start >= "10:00")!;
  assert.equal(afterPine.addedDriveMinutes, driveMinutes(pine, work) + driveMinutes(work, yard) - driveMinutes(pine, yard));
  const minutes = ranked.slots.map((slot) => slot.addedDriveMinutes!);
  assert.deepEqual(minutes, [...minutes].sort((a, b) => a - b), "least added driving first");
  assert.ok(ranked.slots.every((slot) => slot.fits));
  assert.match(slotLines(ranked.slots, NY, "en")[0], new RegExp(`^Wed, Oct 21, .+ with Carlos \\(\\+${ranked.slots[0].addedDriveMinutes} min driving\\)$`));

  // A capacity of 20%: Wednesday's 80 minutes plus this job is over it, Tuesday's isn't. Over-capacity days come last.
  await updateProfile(TEST_ORG, { capacityBp: 2000 }, s.owner.memberId);
  const full = await ask();
  assert.equal(full.slots[0].date, "2026-10-20");
  const firstFull = full.slots.findIndex((slot) => !slot.fits);
  assert.ok(firstFull > 0 && full.slots.slice(firstFull).every((slot) => !slot.fits && slot.date === "2026-10-21"));
  assert.match(slotLines(full.slots.slice(firstFull), NY, "en")[0], /^Wed, Oct 21, .+ with Carlos \(\+\d+ min driving; day would be over capacity\)$/);

  // Nobody named: each member on their own, ranked together; an unplaced yard ranks by time with no added driving.
  const anyone = await findAvailability(s.owner, { from: "tuesday", days: 1, propertyId: next.properties[0].id }, deps);
  assert.deepEqual(new Set(anyone.slots.map((slot) => slot.crew[0].name)), new Set(["Pat Owner", "Carlos Crew", "Ana Crew"]));
  assert.ok(anyone.slots.every((slot) => slot.crew.length === 1));
  await updateProfile(TEST_ORG, { address: null }, s.owner.memberId);
  const unrouted = await ask();
  assert.ok(unrouted.slots.every((slot) => slot.addedDriveMinutes === null));
  assert.deepEqual(unrouted.slots.filter((slot) => slot.fits).map((slot) => slot.startAt.getTime()), unrouted.slots.filter((slot) => slot.fits).map((slot) => slot.startAt.getTime()).sort((a, b) => a - b));
});

withTestDb("equipment: only crew who carry what the work needs are offered, a named crew who don't hear it, and booking them needs the owner's say", async () => {
  const s = await seed();
  const quoted = (await findItemByName(TEST_ORG, "widget service"))!;
  await updateItem(TEST_ORG, quoted.id, { equipment: ["Chipper", "trailer"] }, s.owner.memberId);
  await updateTeamMember(s.owner, s.carlos.memberId, { equipment: ["Trailers"] });
  await updateTeamMember(s.owner, s.ana.memberId, { equipment: ["chipper", "trailer", "60in mower"] });

  // Nobody named: only those who carry it all.
  const anyone = await findAvailability(s.owner, { from: "tuesday", days: 1, quoteId: s.quote.quoteId }, deps);
  assert.deepEqual(anyone.needs, ["Chipper", "trailer"]);
  assert.deepEqual([...new Set(anyone.slots.map((slot) => slot.crew[0].name))], ["Ana Crew"]);
  assert.deepEqual(anyone.missingEquipment, []);

  // Carlos named: his times still, what he lacks, and who carries it; nobody offered in his place.
  const carlos = await findAvailability(s.owner, { memberIds: [s.carlos.memberId], from: "tuesday", days: 1, quoteId: s.quote.quoteId }, deps);
  assert.ok(carlos.slots.length && carlos.slots.every((slot) => slot.crew.map((c) => c.name).join() === "Carlos Crew"));
  assert.deepEqual(carlos.missingEquipment, ["Chipper"]);
  assert.deepEqual(carlos.carriedBy.map((c) => c.name), ["Ana Crew"]);
  const both = await findAvailability(s.owner, { memberIds: [s.carlos.memberId, s.ana.memberId], from: "tuesday", days: 1, quoteId: s.quote.quoteId }, deps);
  assert.deepEqual([both.missingEquipment, both.carriedBy], [[], []], "between them they carry it");

  // The tool says the same, with the lines to send.
  const auth = { auth: { current: { authenticator: "photon-imessage", principalId: `member:${s.owner.memberId}`, attributes: { orgId: TEST_ORG, memberId: s.owner.memberId } } } };
  const input = (findAvailabilityTool.inputSchema as z.ZodType).parse({ memberIds: [s.carlos.memberId], day: "tuesday", days: 1, quoteId: s.quote.quoteId });
  const out = (await findAvailabilityTool.execute(input as never, { session: auth } as never)) as Record<string, any>;
  assert.deepEqual([out.missingEquipment, out.carriedBy.map((c: { name: string }) => c.name)], [["Chipper"], ["Ana Crew"]]);
  assert.match(out.lines[0], /^Tue, \w+ \d+, .+ with Carlos$/, "the tool runs on today's clock; no yard, so no minutes");

  // Booking Carlos is refused, nothing is opened, and the owner saying so books him.
  const book = (extra: Record<string, unknown> = {}) =>
    bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00", ...extra }, deps);
  await assert.rejects(book(), /MISSING_EQUIPMENT: Carlos Crew doesn't carry Chipper, which the work needs/);
  assert.deepEqual((await toSchedule(TEST_ORG)).map((t) => t.kind), ["quote"], "the refused booking opened no work");
  assert.equal((await book({ allowMissingEquipment: true })).visit.crew[0].name, "Carlos Crew");
  assert.ok(await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.ana.memberId], day: "tuesday", time: "13:00" }, deps));

  // Work with no quote needs nothing.
  assert.ok(await bookVisit(s.owner, { title: "Shed", memberIds: [s.carlos.memberId], day: "wednesday", time: "09:00" }, deps));
});

withTestDb("availability over the clocks changing: no slot in the gap, both of the repeated hour", async () => {
  const s = await seed();
  const sundays = [{ day: 0, start: "00:00", end: "05:00" }];
  await setWorkHours(s.owner, { memberId: s.carlos.memberId, hours: sundays }, deps);

  const spring = await findAvailability(s.owner, { memberIds: [s.carlos.memberId], from: "2027-03-14", days: 1, durationMinutes: 30 }, { now: MONDAY_8AM });
  assert.ok(spring.slots.every((slot) => !slot.start.startsWith("02:")), "2 AM doesn't happen that night");
  assert.ok(spring.slots.some((slot) => slot.start === "03:00"));

  const fall = await findAvailability(s.owner, { memberIds: [s.carlos.memberId], from: "2026-11-01", days: 1, durationMinutes: 30 }, { now: MONDAY_8AM });
  const repeated = fall.slots.filter((slot) => slot.start === "01:30");
  assert.deepEqual(repeated.map((slot) => slot.offsetMinutes), [-240, -300]);

  // Booking the repeated hour needs the offset.
  await assert.rejects(
    bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "2026-11-01", time: "01:30" }, deps),
    /AMBIGUOUS_TIME/,
  );
  const second = await bookVisit(
    s.owner,
    { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "2026-11-01", time: "01:30", offsetMinutes: -300 },
    deps,
  );
  assert.equal(second.visit.startAt.toISOString(), "2026-11-01T06:30:00.000Z");
  await assert.rejects(
    bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "2027-03-14", time: "02:30" }, deps),
    /NONEXISTENT_TIME/,
  );
});

withTestDb("crew read the whole schedule and mark any visit done; booking and moving is the owner's", async () => {
  const s = await seed();
  const mine = await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00" }, deps);
  const anas = await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.ana.memberId], day: "tuesday", time: "11:00" }, deps);

  const carlosWeek = await readSchedule(s.carlos, { from: "2026-10-19", days: 7 }, deps);
  assert.deepEqual(carlosWeek.visits.map((v) => v.visitId), [mine.visit.visitId, anas.visit.visitId]);
  assert.equal(carlosWeek.crew.length, 3);
  const asked = await readSchedule(s.carlos, { from: "2026-10-19", days: 7, memberId: s.ana.memberId }, deps);
  assert.deepEqual(asked.visits.map((v) => v.visitId), [anas.visit.visitId], "crew can ask about someone else");
  const everyone = await readSchedule(s.owner, { from: "2026-10-19", days: 7 }, deps);
  assert.equal(everyone.visits.length, 2);
  assert.equal(everyone.crew.length, 3);
  assert.equal((await readSchedule(s.owner, { from: "2026-10-19", days: 7, memberId: s.ana.memberId }, deps)).visits.length, 1);
  assert.equal(await getServiceJob(s.ana, mine.visit.jobId).then((job) => job?.visits.length), 2, "crew see every visit on a job");

  await assert.rejects(bookVisit(s.carlos, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "wednesday", time: "09:00" }, deps), /NOT_PRIVILEGED/);
  await assert.rejects(rescheduleVisit(s.carlos, { visitId: mine.visit.visitId, time: "10:00" }, deps), /NOT_PRIVILEGED/);
  await assert.rejects(changeVisitStatus(s.carlos, { visitId: mine.visit.visitId, status: "cancelled" }, deps), /NOT_PRIVILEGED/);
  assert.ok((await findAvailability(s.carlos, { memberIds: [s.ana.memberId], from: "tuesday" }, deps)).slots, "crew can look up anyone's openings");
  await assert.rejects(addTimeOff(s.carlos, { memberId: s.ana.memberId, day: "friday" }, deps), /NOT_PRIVILEGED/);
  await assert.rejects(createServiceJob(s.carlos, { title: "Shed" }, deps), /NOT_PRIVILEGED/);

  // Done only once its day has come; anyone's, since someone may finish another crew's job.
  await assert.rejects(changeVisitStatus(s.carlos, { visitId: mine.visit.visitId, status: "completed" }, deps), /VISIT_NOT_STARTED/);
  const tuesday = { ...deps, now: new Date("2026-10-20T19:00:00Z") };
  assert.equal((await changeVisitStatus(s.carlos, { visitId: anas.visit.visitId, status: "completed" }, tuesday)).visit.status, "completed");
  const done = await changeVisitStatus(s.carlos, { visitId: mine.visit.visitId, status: "completed", visitNotes: "All good" }, tuesday);
  assert.equal(done.visit.status, "completed");
  assert.equal(done.visit.notes, "All good");
  assert.equal(done.openVisitsOnJob, 0, "Ana's visit on the same job was finished by Carlos too");

  const off = await addTimeOff(s.carlos, { memberId: s.carlos.memberId, day: "friday" }, deps);
  await assert.rejects(removeTimeOff(s.ana, off.id), /TIME_OFF_NOT_FOUND/);
  assert.equal((await removeTimeOff(s.carlos, off.id)).cancelledAt instanceof Date, true);
});

withTestDb("moving a visit keeps what isn't said, skips its own time, and tells who's on it", async () => {
  const s = await seed();
  const { visit } = await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00", durationMinutes: 120 }, deps);
  texts = [];
  const later = await rescheduleVisit(s.owner, { visitId: visit.visitId, time: "09:30" }, deps);
  assert.equal(later.visit.startAt.toISOString(), "2026-10-20T13:30:00.000Z");
  assert.equal(later.visit.endAt.toISOString(), "2026-10-20T15:30:00.000Z", "still two hours");
  assert.equal(later.visit.revision, 2);
  assert.deepEqual(texts, [{ memberId: s.carlos.memberId, text: "Pat Owner moved 12 Oak St to Tue, Oct 20, 9:30 AM–11:30 AM." }]);

  texts = [];
  const swapped = await rescheduleVisit(s.owner, { visitId: visit.visitId, memberIds: [s.ana.memberId], reason: "Carlos is out" }, deps);
  assert.deepEqual(swapped.visit.crew.map((c) => c.name), ["Ana Crew"]);
  assert.deepEqual(texts.map((t) => t.text), [
    "Pat Owner booked you for 12 Oak St: Tue, Oct 20, 9:30 AM–11:30 AM.\n\n1. widget service, 10 widgets",
    "Pat Owner took you off 12 Oak St (Tue, Oct 20, 9:30 AM).",
  ]);
  const history = await db().select().from(visitRevisions).where(eq(visitRevisions.visitId, visit.visitId));
  assert.deepEqual(history.map((h) => h.action).sort(), ["booked", "rescheduled", "rescheduled"]);

  await changeVisitStatus(s.owner, { visitId: visit.visitId, status: "cancelled" }, deps);
  await assert.rejects(rescheduleVisit(s.owner, { visitId: visit.visitId, time: "10:00" }, deps), /VISIT_NOT_OPEN/);
});

withTestDb("closing a job: visits ahead are asked about, started ones are marked done, and completion is recorded", async () => {
  const s = await seed();
  const first = await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "09:00" }, deps);
  await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "thursday", time: "09:00" }, deps);
  const wednesday = { ...deps, now: new Date("2026-10-21T16:00:00Z") };

  await assert.rejects(closeServiceJob(s.owner, { jobId: first.visit.jobId, status: "completed" }, wednesday), /VISITS_AHEAD: Thu, Oct 22/);
  texts = [];
  const closed = await closeServiceJob(s.owner, { jobId: first.visit.jobId, status: "completed", cancelUpcomingVisits: true }, wednesday);
  assert.equal(closed.job.status, "completed");
  assert.equal(closed.completedVisits, 1);
  assert.equal(closed.cancelledVisits.length, 1);
  assert.deepEqual(closed.job.visits.map((v) => v.status), ["completed", "cancelled"]);
  assert.match(texts[0]?.text ?? "", /cancelled 12 Oak St on Thu, Oct 22/);
  const [completed] = await db()
    .select()
    .from(events)
    .where(and(eq(events.orgId, TEST_ORG), eq(events.kind, "service_job.completed")));
  assert.equal(completed.refId, first.visit.jobId);
  await assert.rejects(closeServiceJob(s.owner, { jobId: first.visit.jobId, status: "cancelled" }, wednesday), /JOB_CLOSED/);
  await assert.rejects(bookVisit(s.owner, { jobId: first.visit.jobId, memberIds: [s.carlos.memberId], day: "friday", time: "09:00" }, deps), /JOB_CLOSED/);

  // Work on its own needs a title, and waits to be scheduled until it has a visit.
  await assert.rejects(createServiceJob(s.owner, {}, deps), /JOB_TITLE_REQUIRED/);
  const shed = await createServiceJob(s.owner, { title: "Back shed", customerId: s.customer.id }, deps);
  assert.deepEqual((await toSchedule(TEST_ORG)).map((t) => t.kind === "job" && t.jobId), [shed.job.id]);
});

withTestDb("the morning line names today's visits: crew their own route, owners the business's, never in quiet hours", async () => {
  const s = await seed();
  await updateProfile(TEST_ORG, { address: "100 Bridge Rd, Tequesta, FL" }, s.owner.memberId);
  const sentTo: Record<string, string[]> = {};
  let n = 0;
  setTransportForTests({
    postText: async (threadId, text) => {
      (sentTo[threadId] ??= []).push(text);
      return [`sent_${++n}`];
    },
    postFile: async () => `file_${++n}`,
    addReaction: async () => {},
  });
  const sunday = { ...deps, now: new Date("2026-10-18T16:00:00Z") };
  await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "2026-10-19", time: "09:00" }, sunday);
  await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.ana.memberId, s.carlos.memberId], day: "2026-10-19", time: "13:30" }, sunday);
  await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.ana.memberId], day: "2026-10-20", time: "09:00" }, sunday);

  const counts = await runOrgTick(TEST_ORG, MONDAY_8AM);
  assert.equal(counts.mornings, 3);
  // Crew hear their day as a route: from the yard, each stop with the drive in, and back.
  assert.deepEqual(sentTo["thread:+15555550102"], [
    "Good morning. Your day: leave the yard 8:50 AM → 9 AM 12 Oak St (10 min) → 1:30 PM 12 Oak St → back by 2:40 PM.",
  ]);
  assert.deepEqual(sentTo["thread:+15555550103"], ["Good morning. Your day: leave the yard 1:20 PM → 1:30 PM 12 Oak St (10 min) → back by 2:40 PM."]);
  assert.deepEqual(sentTo["thread:+15555550101"], [
    "Good morning. 2 visits today: 9 AM 12 Oak St (Carlos), 1:30 PM 12 Oak St (Carlos, Ana). 1 draft in progress.",
  ]);

  // Quiet until 9: the 8 o'clock line doesn't go out.
  await updateProfile(TEST_ORG, { quietEndHour: 9 }, s.owner.memberId);
  for (const key of Object.keys(sentTo)) delete sentTo[key];
  assert.equal((await runOrgTick(TEST_ORG, new Date("2026-10-20T12:00:00Z"))).mornings, 0);
  assert.deepEqual(sentTo, {});
});

withTestDb("hours: the business's by default, a member's own when set, and visits now outside them are named", async () => {
  const s = await seed();
  await bookVisit(s.owner, { quoteId: s.quote.quoteId, memberIds: [s.carlos.memberId], day: "tuesday", time: "15:00" }, deps);
  const early = await setWorkHours(s.owner, { memberId: s.carlos.memberId, hours: [2].map((day) => ({ day, start: "07:00", end: "15:00" })) }, deps);
  assert.deepEqual(early.outsideHours.map((v) => v.title), ["12 Oak St"]);
  const carlos = (await readSchedule(s.owner, { from: "tuesday", days: 1, memberId: s.carlos.memberId }, deps)).crew[0];
  assert.equal(carlos.ownHours, true);
  await setWorkHours(s.owner, { memberId: s.carlos.memberId, hours: null }, deps);
  const back = (await readSchedule(s.owner, { from: "tuesday", days: 1, memberId: s.carlos.memberId }, deps)).crew[0];
  assert.equal(back.ownHours, false);
  assert.equal(back.hours.length, 5);
  await assert.rejects(setWorkHours(s.owner, { hours: [{ day: 1, start: "17:00", end: "08:00" }] }, deps), /INVALID_HOURS/);
  await assert.rejects(setWorkHours(s.carlos, { memberId: s.carlos.memberId, hours: null }, deps), /NOT_PRIVILEGED/);
});
