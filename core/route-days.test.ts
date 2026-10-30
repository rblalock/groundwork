import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { proposals, serviceJobs } from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { addPhone, createMember, recordInbound, type Caller } from "./members";
import type { Point } from "./places";
import { saveItems } from "./pricebook";
import { updateProfile } from "./profile";
import { applyProposal, openProposals, proposalForTool } from "./proposals";
import { approveQuote, createQuote, setQuoteOutcome, type Poster } from "./quotes";
import {
  assignWeekdays,
  bearingFrom,
  cutArcs,
  nearestLoop,
  planRouteDays,
  proposeRouteDays,
  recurringJobCount,
  routeDayCrewText,
  routeDayCustomerText,
  routeDayFor,
  routeDayLines,
  routeDaysReason,
  workWeekdays,
} from "./route-days";
import { bookVisit, findAvailability, getVisit, setWorkHours, type Slot } from "./scheduling";
import { wallClock, weekdayOf } from "./scheduling-time";
import { TEST_ORG, withTestDb } from "./test-db";

const TZ = "America/New_York";
const local = (date: string, clock: string) => new Date(`${date}T${clock}:00-05:00`);
const yard: Point = { lat: 0, lng: 0 };
/** A point a little way out from the yard on a bearing, in degrees clockwise from north. */
const toward = (degrees: number, name: string) => ({
  name,
  place: { lat: 0.01 * Math.cos((degrees * Math.PI) / 180), lng: 0.01 * Math.sin((degrees * Math.PI) / 180) },
});
const names = (arcs: Array<Array<{ name: string }>>) => arcs.map((arc) => arc.map((s) => s.name));

test("route days: bearings run clockwise from north", () => {
  assert.equal(Math.round(bearingFrom(yard, { lat: 1, lng: 0 })), 0);
  assert.equal(Math.round(bearingFrom(yard, { lat: 0, lng: 1 })), 90);
  assert.equal(Math.round(bearingFrom(yard, { lat: -1, lng: 0 })), 180);
  assert.equal(Math.round(bearingFrom(yard, { lat: 0, lng: -1 })), 270);
});

test("route days: the circle is cut into contiguous, balanced arcs from the widest gap", () => {
  const stops = [toward(200, "c1"), toward(10, "a1"), toward(110, "b2"), toward(20, "a2"), toward(210, "c2"), toward(100, "b1")];
  assert.deepEqual(names(cutArcs(yard, stops, 3)), [["a1", "a2"], ["b1", "b2"], ["c1", "c2"]], "the empty west is where the cut starts");
  assert.deepEqual(names(cutArcs(yard, stops, 5)), [["a1", "a2"], ["b1"], ["b2"], ["c1"], ["c2"]], "differing by one at most, the larger first");
  assert.deepEqual(names(cutArcs(yard, stops, 1)), [["a1", "a2", "b1", "b2", "c1", "c2"]]);
  assert.deepEqual(names(cutArcs(yard, stops.slice(0, 2), 5)), [["c1"], ["a1"]], "no more arcs than stops, after the wider gap (east)");
  assert.deepEqual(cutArcs(yard, [], 5), []);
  // The widest gap is south to north-west, so the arc across north holds together.
  const north = [toward(350, "n1"), toward(5, "n2"), toward(15, "n3"), toward(180, "s")];
  assert.deepEqual(names(cutArcs(yard, north, 2)), [["n1", "n2"], ["n3", "s"]]);
});

test("route days: arcs go to the weekdays that keep the most stops where they are", () => {
  assert.deepEqual(assignWeekdays([[{ weekday: 2 }, { weekday: 2 }], [{ weekday: 1 }]], [1, 2, 3]), [2, 1]);
  assert.deepEqual(assignWeekdays([[{ weekday: null }], [{ weekday: null }]], [1, 2, 3]), [1, 2], "in weekday order on a tie");
  assert.deepEqual(workWeekdays([0, 2, 4, 6, 2].map((day) => ({ day, start: "08:00", end: "12:00" }))), [2, 4], "weekdays only");
  const days = planRouteDays(
    yard,
    [
      { jobId: "east", place: toward(90, "").place, weekday: 1 },
      { jobId: "north", place: toward(0, "").place, weekday: 5 },
      { jobId: "north2", place: toward(10, "").place, weekday: 1 },
    ],
    [1, 5],
  );
  assert.deepEqual(days.map((d) => [d.weekday, d.jobs.map((j) => j.jobId)]), [[1, ["east"]], [5, ["north", "north2"]]]);
  assert.equal(routeDaysReason(days, "en"), "3 recurring stops by area, one loop a weekday (Mon 1, Fri 2)");
  // Four stops on two days with five days worked make two loops, not four single stops.
  const two = planRouteDays(
    yard,
    [
      { jobId: "oak1", place: toward(0, "").place, weekday: 1 },
      { jobId: "oak2", place: toward(8, "").place, weekday: 1 },
      { jobId: "pine1", place: toward(180, "").place, weekday: 3 },
      { jobId: "pine2", place: toward(172, "").place, weekday: 1 },
    ],
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(two.map((d) => [d.weekday, d.jobs.map((j) => j.jobId).sort()]), [[1, ["oak1", "oak2"]], [3, ["pine1", "pine2"]]]);
});

test("route days: the drafts say the new weekday and the first visit on it, with no prices", () => {
  const to = { date: "2026-11-10", startAt: local("2026-11-10", "09:00"), endAt: local("2026-11-10", "10:00") };
  assert.equal(
    routeDayCustomerText({ work: "Lawn mowing", to }, { name: "Maria Alvarez", language: "en" }, "Ortega Lawn", TZ),
    "Hi Maria, it's Ortega Lawn. We're setting your regular lawn mowing to Tuesdays, starting Nov 10 at 9 AM. Reply if that doesn't work.",
  );
  assert.match(
    routeDayCustomerText({ work: null, to }, { name: null, language: "es" }, "Ortega Lawn", TZ),
    /^Hola, le escribe Ortega Lawn\. Pasamos su visita regular a los martes, a partir del 10 nov a las 9 a\.\s?m\. Avísenos si no le funciona\.$/,
  );
  assert.equal(routeDayCrewText({ title: "12 Oak St", to }, TZ, "en"), "12 Oak St moves to Tuesdays, from Tue, Nov 10, 9 AM–10 AM.");
});

test("route days: new recurring work goes on the loop it adds the least driving to", () => {
  // Points miles apart, so the drives' rounding to 5 minutes doesn't decide it.
  const north = [{ lat: 0.1, lng: 0 }, { lat: 0.2, lng: 0 }];
  const east = [{ lat: 0, lng: 0.1 }];
  const near = { lat: 0.15, lng: 0.001 };
  assert.deepEqual(nearestLoop(yard, near, [{ weekday: 3, places: east }, { weekday: 1, places: north }]), { weekday: 1, addedDriveMinutes: 0 }, "on the way out north");
  assert.equal(nearestLoop(yard, { lat: 0, lng: 0.12 }, [{ weekday: 1, places: north }, { weekday: 3, places: east }])?.weekday, 3);
  assert.equal(nearestLoop(yard, { lat: 0.1, lng: 0.1 }, [{ weekday: 4, places: north.slice(0, 1) }, { weekday: 2, places: east }])?.weekday, 2, "a tie goes to the earlier weekday");
  assert.equal(nearestLoop(yard, near, [{ weekday: 2, places: [] }]), null, "a day with no recurring stops yet isn't a loop");

  const slot = (date: string, clock: string, added: number): Slot => {
    const startAt = local(date, clock);
    return {
      date,
      start: clock,
      end: "",
      startAt,
      endAt: new Date(startAt.getTime() + 3_600_000),
      offsetMinutes: -300,
      crew: [{ memberId: "mem_carlos", name: "Carlos Reyes" }],
      driveFromPreviousMinutes: 5,
      driveToNextMinutes: 5,
      driveEstimated: true,
      addedDriveMinutes: added,
      fits: true,
    };
  };
  const ranked = [slot("2026-11-11", "09:00", 5), slot("2026-11-10", "13:00", 10), slot("2026-11-10", "10:00", 15)];
  assert.deepEqual(routeDayLines(ranked, TZ, "en", { weekday: 2, label: "your Tue loop" }), [
    "Tue, Nov 10, 1 PM with Carlos (+10 min driving; your Tue loop)",
    "Wed, Nov 11, 9 AM with Carlos (+5 min driving)",
    "Tue, Nov 10, 10 AM with Carlos (+15 min driving; your Tue loop)",
  ]);
});

// ---------------------------------------------------------------------------------------------
// On the database

const NOW = local("2026-11-05", "07:00"); // a Thursday

async function person(name: string, role: Caller["role"], phone: string): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role, language: "en" });
  const row = await addPhone(TEST_ORG, member.id, phone);
  await recordInbound(TEST_ORG, row.id, `thread:${phone}`, new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: phone };
}

/**
 * Ortega Lawn works Tuesdays and Thursdays from the yard at 100 Bridge Rd. Carlos mows weekly at 412 Oak St and 7 Pine
 * Ave on Tuesdays, and at 12 Oak St (Maria Alvarez, from a quote) and 40 Pine Ave on Thursdays: each day goes both ways.
 */
async function mixedWeek() {
  const post: Poster = async () => ({ posted: true });
  const owner = await person("Pat Ortega", "owner", "+15555550101");
  const crew = await person("Carlos Reyes", "member", "+15555550102");
  await updateProfile(TEST_ORG, { name: "Ortega Lawn", timeZone: TZ, address: "100 Bridge Rd, Tequesta, FL" }, owner.memberId);
  await setWorkHours(owner, { hours: [2, 4].map((day) => ({ day, start: "08:00", end: "17:00" })) }, { now: NOW });
  const [mowing] = await saveItems(TEST_ORG, [{ name: "Lawn mowing", unitKind: "visit", unitLabel: "visit", priceCents: 6500 }], owner.memberId);
  const book = async (name: string, address: string, day: string, time: string, fromQuote = false) => {
    const customer = await saveCustomer(TEST_ORG, { name, address }, owner.memberId);
    const propertyId = customer.properties[0].id;
    let quoteId: string | undefined;
    if (fromQuote) {
      const quote = await createQuote({ title: address, customerId: customer.id, propertyId, lines: [{ itemId: mowing.id, quantity: 1 }] }, owner, { post });
      await approveQuote(quote.quoteId, owner, { post });
      await setQuoteOutcome(quote.quoteId, "won", owner, { post });
      quoteId = quote.quoteId;
    }
    const booked = await bookVisit(
      owner,
      { ...(quoteId ? { quoteId } : { title: address, customerId: customer.id, propertyId }), memberIds: [crew.memberId], day, time, recurring: "weekly" },
      { now: NOW, post },
    );
    return booked.visit;
  };
  const visits = {
    oak: await book("Oak Customer", "412 Oak St", "2026-11-10", "09:00"),
    pine: await book("Pine Customer", "7 Pine Ave", "2026-11-10", "13:00"),
    maria: await book("Maria Alvarez", "12 Oak St", "2026-11-12", "09:00", true),
    far: await book("Far Customer", "40 Pine Ave", "2026-11-12", "13:00"),
  };
  return { owner, crew, post, visits };
}

withTestDb("route days: each area gets one weekday, and applying moves the next visit and the work's day", async () => {
  const { owner, crew, post, visits } = await mixedWeek();
  assert.equal(await recurringJobCount(TEST_ORG), 4);
  await assert.rejects(proposeRouteDays(crew, { now: NOW }), /NOT_PRIVILEGED/);

  const { proposal, text } = await proposeRouteDays(owner, { now: NOW });
  assert.ok(proposal);
  assert.deepEqual([proposal.kind, proposal.memberId, proposal.date, proposal.status], ["route_days", null, "2026-11-05", "open"]);
  assert.equal(proposal.reason, "4 recurring stops by area, one loop a weekday (Tue 2, Thu 2)");
  assert.deepEqual(
    proposal.items.map((i) => [i.visitId, i.to.date, i.to.memberIds]),
    [
      [visits.maria.visitId, "2026-11-10", [crew.memberId]],
      [visits.pine.visitId, "2026-11-12", [crew.memberId]],
    ],
    "the Oaks on Tuesday and the Pines on Thursday, next week, each with its own crew",
  );
  assert.match(
    text,
    /^4 recurring stops by area, one loop a weekday \(Tue 2, Thu 2\)\.\nMove 2 recurring stops to their area's day\?\n1\. 12 Oak St: Thu → Tue from Tue, Nov 10, \d{1,2}(:\d{2})? (AM|PM) \(Carlos\)\n2\. 7 Pine Ave: Tue → Thu from Thu, Nov 12, \d{1,2}(:\d{2})? (AM|PM) \(Carlos\)\nReply the numbers to keep, 'all', or 'no'\.$/,
  );
  assert.match(proposal.items[0].customerText, /^Hi Maria, it's Ortega Lawn\. We're setting your regular lawn mowing to Tuesdays, starting Nov 10 at /);
  assert.ok(proposal.items.every((i) => !/\$|\d+\.\d\d/.test(i.customerText)), "no prices");

  // Asking again replaces the open one.
  const again = await proposeRouteDays(owner, { now: NOW });
  const [first] = await db().select().from(proposals).where(eq(proposals.id, proposal.id));
  assert.equal(first.status, "expired");
  const open = (await openProposals(owner, { now: NOW })).proposals;
  assert.deepEqual(open.map((p) => p.id), [again.proposal!.id]);
  assert.equal(proposalForTool(open[0], TZ, "en").kind, "route_days");

  const applied = await applyProposal(owner, { proposalId: again.proposal!.id }, { now: NOW, post });
  assert.deepEqual(applied.moved.map((m) => m.itemId), ["1", "2"]);
  assert.match(applied.summaryText, /^Moved 2 stops: 12 Oak St: Thu → Tue from Tue, Nov 10, /);
  const moved = await getVisit(owner, visits.maria.visitId);
  assert.equal(moved?.startAt.toISOString(), again.proposal!.items[0].to.startAt);
  const [job] = await db().select().from(serviceJobs).where(and(eq(serviceJobs.orgId, TEST_ORG), eq(serviceJobs.id, visits.maria.jobId)));
  assert.equal(job.recurrence?.weekday, 2, "the work is on Tuesdays now");
  assert.equal(job.recurrence?.time, wallClock(moved!.startAt, TZ).time);
  assert.equal(weekdayOf(wallClock(moved!.startAt, TZ).date), 2);

  const settled = await proposeRouteDays(owner, { now: NOW });
  assert.equal(settled.proposal, null);
  assert.equal(settled.text, "4 recurring stops by area, one loop a weekday (Tue 2, Thu 2). Each one is already on its area's day, so nothing moves.");
});

withTestDb("route days: with fewer than two recurring stops placed, or no yard, the code says why", async () => {
  const owner = await person("Pat Ortega", "owner", "+15555550101");
  assert.match((await proposeRouteDays(owner, { now: NOW })).text, /^The yard's address isn't placed/);
  await updateProfile(TEST_ORG, { name: "Ortega Lawn", timeZone: TZ, address: "100 Bridge Rd, Tequesta, FL" }, owner.memberId);
  assert.equal((await proposeRouteDays(owner, { now: NOW })).text, "Route days need at least 2 recurring stops with a placed address; there are 0.");
});

withTestDb("route days: find_availability's route day for a new recurring customer is the weekday their neighbours are on", async () => {
  const { owner, visits } = await mixedWeek();
  const sam = await saveCustomer(TEST_ORG, { name: "Sam Lee", address: "412 Oak St" }, owner.memberId);
  const found = await findAvailability(owner, { propertyId: sam.properties[0].id, from: "2026-11-09", days: 5 }, { now: NOW });
  assert.equal(found.recurring, false, "new work, so the member says it repeats");
  const routeDay = await routeDayFor(TEST_ORG, { place: found.place, excludeJobId: found.jobId }, "en");
  assert.deepEqual(routeDay && [routeDay.weekday, routeDay.label], [2, "your Tue loop"], "412 Oak St's own loop");
  const lines = routeDayLines(found.slots, found.timeZone, "en", routeDay!);
  assert.match(lines[0], /^Tue, Nov 10, .* with Carlos \(.*your Tue loop\)$/);

  // Recurring work of its own is placed among the others, itself left out.
  const own = await findAvailability(owner, { jobId: visits.far.jobId, from: "2026-11-09", days: 5 }, { now: NOW });
  assert.deepEqual([own.recurring, own.jobId], [true, visits.far.jobId]);
  // Next to 7 Pine Ave, it adds 5 minutes to Tuesday's loop and as many to Thursday's (12 Oak St alone without it):
  // a tie goes to the day with fewer stops.
  assert.equal((await routeDayFor(TEST_ORG, { place: own.place, excludeJobId: own.jobId }, "es"))?.label, "tu ruta del jue");
});
