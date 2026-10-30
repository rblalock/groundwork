import assert from "node:assert/strict";
import type { z } from "zod";
import { saveCustomer } from "../../core/customers";
import { saveItems } from "../../core/pricebook";
import { updateProfile } from "../../core/profile";
import { approveQuote, createQuote, setQuoteOutcome, type Poster } from "../../core/quotes";
import { addTimeOff, bookVisit } from "../../core/scheduling";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { addDays } from "../../core/time";
import { wallClock } from "../../core/scheduling-time";
import { GET as hoursGet, PUT as hoursPut } from "../../app/api/schedule/hours/route";
import { POST as availabilityRoute } from "../../app/api/schedule/availability/route";
import { POST as closeRoute } from "../../app/api/schedule/jobs/[id]/close/route";
import { POST as timeOffRoute } from "../../app/api/schedule/time-off/route";
import { POST as bookRoute } from "../../app/api/schedule/visits/route";
import { PATCH as moveRoute } from "../../app/api/schedule/visits/[id]/route";
import { POST as statusRoute } from "../../app/api/schedule/visits/[id]/status/route";
import { customerFor } from "./customers";
import { quoteFor } from "./quotes";
import readScheduleTool from "../../agents/assistant/agent/tools/read_schedule";
import { moveRequest } from "../schedule-presentation";
import { scheduleFor, visitJson, workOn } from "./schedule";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const quiet: Poster = async () => ({ posted: true });
const TZ = "America/New_York";
/** A weekday at least a few days out, so bookings are in the future and inside working hours. */
function nextWeekday(): string {
  let day = addDays(wallClock(new Date(), TZ).date, 3);
  while ([0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) day = addDays(day, 1);
  return day;
}

/** An owner's won quote booked for crew A; crew B has nothing; another business has its own visit. */
async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crewA = await person("Sam Crew", "member", "+15555550102");
  const crewB = await person("Lee Crew", "member", "+15555550103");
  await updateProfile(TEST_ORG, { timeZone: TZ }, owner.memberId);
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const customer = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "1 Sample St" }, owner.memberId);
  const quote = await createQuote(
    { title: "1 Sample St", customerId: customer.id, propertyId: customer.properties[0].id, lines: [{ itemId: item.id, quantity: 10 }] },
    owner,
    { post: quiet },
  );
  await approveQuote(quote.quoteId, owner, { post: quiet });
  await setQuoteOutcome(quote.quoteId, "won", owner, { post: quiet });
  const won = await createQuote({ title: "2 Sample St", lines: [{ itemId: item.id, quantity: 3 }] }, owner, { post: quiet });
  await approveQuote(won.quoteId, owner, { post: quiet });
  await setQuoteOutcome(won.quoteId, "won", owner, { post: quiet });
  const day = nextWeekday();
  const { visit } = await bookVisit(owner, { quoteId: quote.quoteId, memberIds: [crewA.memberId], day, time: "09:00" }, { post: quiet });

  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  const otherVisit = await bookVisit(otherOwner, { title: "9 Other Rd", memberIds: [otherOwner.memberId], day, time: "09:00" }, { post: quiet });
  return { owner, crewA, crewB, customer, quote, won, day, visit, otherVisit: otherVisit.visit };
}

withTestDb("schedule: everyone sees every lane; only owners and admins see the work to book", async () => {
  const s = await seed();
  const owner = await appCaller(await signIn("+15555550101"));
  const crewA = await appCaller(await signIn("+15555550102"));
  const crewB = await appCaller(await signIn("+15555550103"));

  const week = await scheduleFor(owner, { view: "week", date: s.day });
  assert.equal(week.dates.length, 7);
  assert.deepEqual(week.crew.map((c) => c.name), ["Pat Owner", "Sam Crew", "Lee Crew"]);
  assert.deepEqual(week.visits.map((v) => v.visitId), [s.visit.visitId]);
  assert.deepEqual(week.toSchedule.map((t) => t.title), ["2 Sample St"]);
  assert.equal(week.canManage, true);

  const mine = await scheduleFor(crewA, { date: s.day });
  assert.equal(mine.view, "route", "crew start on their route when the day has visits");
  assert.deepEqual(mine.plans.map((p) => [p.name, p.stops.map((stop) => stop.visitId)]), [["Sam Crew", [s.visit.visitId]]]);
  assert.deepEqual(mine.crew.map((c) => c.name), ["Pat Owner", "Sam Crew", "Lee Crew"]);
  assert.deepEqual(mine.visits.map((v) => v.visitId), [s.visit.visitId]);
  assert.deepEqual(mine.toSchedule, []);
  assert.equal(mine.canManage, false);
  const idle = await scheduleFor(crewB, { date: s.day });
  assert.deepEqual([idle.view, idle.plans], ["day", []], "else on their day");
  assert.deepEqual((await scheduleFor(crewB, { view: "route", date: s.day })).plans, [], "crew see only their own route");
  const routes = await scheduleFor(owner, { view: "route", date: s.day });
  assert.deepEqual([routes.dates, routes.plans.map((p) => p.name)], [[s.day], ["Sam Crew"]]);
  assert.equal(typeof routes.plans[0].stops[0].startAt, "string");
  assert.deepEqual(week.plans, [], "only the route view carries plans");
  const theirs = await scheduleFor(crewB, { view: "week", date: s.day });
  assert.deepEqual(theirs.visits.map((v) => v.visitId), [s.visit.visitId], "a visit they're not on shows too");
  assert.deepEqual(theirs.crew.map((c) => c.name), ["Pat Owner", "Sam Crew", "Lee Crew"]);

  // The route view's weather strip: the fake's forecast at the yard, for a day it reaches; none past it or without a yard.
  assert.equal(routes.weather, null, "a day past the forecast's reach");
  const tomorrow = addDays(wallClock(new Date(), TZ).date, 1);
  assert.equal((await scheduleFor(owner, { view: "route", date: tomorrow })).weather, null, "the yard isn't placed");
  await updateProfile(TEST_ORG, { address: "100 Bridge Rd, Tequesta, FL" }, s.owner.memberId);
  const rainy = await scheduleFor(crewB, { view: "route", date: tomorrow });
  assert.equal(rainy.weather, "Tomorrow: rain 70% 10 AM–2 PM, high 85°F", "everyone sees it");
  assert.equal((await scheduleFor(owner, { view: "week", date: tomorrow })).weather, null, "only on the route view");
  const auth = { auth: { current: { authenticator: "photon-imessage", principalId: `member:${s.owner.memberId}`, attributes: { orgId: TEST_ORG, memberId: s.owner.memberId } } } };
  const read = async (input: object) =>
    (await readScheduleTool.execute((readScheduleTool.inputSchema as z.ZodType).parse(input) as never, { session: auth } as never)) as Record<string, unknown>;
  const lines = (await read({ day: "today", days: 2 })).weather as string[];
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Today: rain 10% at most, high \d+°F$/, "the rest of today");
  assert.equal(lines[1], "Tomorrow: rain 70% 10 AM–2 PM, high 85°F");
  assert.equal((await read({ day: s.day })).weather, undefined, "none for a day past its reach");

  // Anyone opens the visit's quote, customer, and work, on it or not.
  for (const crew of [crewA, crewB]) {
    assert.equal((await quoteFor(crew, s.quote.quoteId)).quote.title, "1 Sample St");
    assert.equal((await customerFor(crew, s.customer.id)).customer.name, "Ada Sample");
    assert.equal((await workOn(crew, { quoteId: s.quote.quoteId }))[0].visits.length, 1);
  }
});

withTestDb("schedule routes: owners book and move; crew mark visits done and nothing else", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");
  const otherCrewHeaders = await signIn("+15555550103");
  const book = { quoteId: s.won.quoteId, memberIds: [s.crewB.memberId], date: s.day, time: "13:00", durationMinutes: 90 };

  refused(await call(bookRoute, crewHeaders, { body: book }), 403, "NOT_PRIVILEGED");
  const booked = await call(bookRoute, ownerHeaders, { body: book });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  const visitId = (booked.body?.visit as { visitId: string }).visitId;

  const clash = await call(bookRoute, ownerHeaders, { body: { ...book, quoteId: s.quote.quoteId, time: "13:30" } });
  refused(clash, 409, "CREW_BUSY");
  assert.match(String(clash.body?.error), /Someone on the crew already has a visit then\. Lee Crew has 2 Sample St/);
  refused(await call(bookRoute, ownerHeaders, { body: { ...book, time: "18:00" } }), 409, "OUTSIDE_HOURS");
  assert.equal((await call(bookRoute, ownerHeaders, { body: { ...book, time: "18:00", allowOutsideHours: true } })).status, 200);

  refused(await call(moveRoute, crewHeaders, { method: "PATCH", params: { id: visitId }, body: { time: "14:00" } }), 403);
  const moved = await call(moveRoute, ownerHeaders, { method: "PATCH", params: { id: visitId }, body: { time: "14:00" } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  refused(await call(moveRoute, ownerHeaders, { method: "PATCH", params: { id: s.otherVisit.visitId }, body: { time: "14:00" } }), 404);

  // Crew mark anyone's visit done, but not before its day, and they don't cancel.
  refused(await call(statusRoute, crewHeaders, { params: { id: visitId }, body: { status: "completed" } }), 409, "VISIT_NOT_STARTED");
  refused(await call(statusRoute, crewHeaders, { params: { id: s.visit.visitId }, body: { status: "cancelled" } }), 403);
  refused(await call(statusRoute, crewHeaders, { params: { id: s.visit.visitId }, body: { status: "completed" } }), 409, "VISIT_NOT_STARTED");
  refused(await call(statusRoute, otherCrewHeaders, { params: { id: s.otherVisit.visitId }, body: { status: "completed" } }), 404);

  // Availability: crew look up anyone's.
  assert.equal((await call(availabilityRoute, crewHeaders, { body: { memberIds: [s.crewB.memberId], date: s.day, durationMinutes: 60 } })).status, 200);
  const own = await call(availabilityRoute, crewHeaders, { body: { memberIds: [s.crewA.memberId], date: s.day, days: 1, durationMinutes: 60 } });
  assert.equal(own.status, 200);
  assert.ok(!(own.body?.slots as Array<{ start: string }>).some((slot) => slot.start === "09:00"), "their 9 AM visit");

  // Time off: crew their own only; hours and closing work are the owner's.
  refused(await call(timeOffRoute, crewHeaders, { body: { memberId: s.crewB.memberId, date: s.day } }), 403);
  refused(await call(timeOffRoute, crewHeaders, { body: { memberId: s.crewA.memberId, date: s.day } }), 409, "HAS_VISITS");
  assert.equal((await call(timeOffRoute, crewHeaders, { body: { memberId: s.crewA.memberId, date: addDays(s.day, 1) } })).status, 200);
  refused(await call(hoursGet, crewHeaders), 403);
  refused(await call(hoursPut, crewHeaders, { method: "PUT", body: { memberId: null, hours: [] } }), 403);
  const hours = await call(hoursPut, ownerHeaders, { method: "PUT", body: { memberId: s.crewA.memberId, hours: [{ day: 6, start: "08:00", end: "12:00" }] } });
  assert.equal(hours.status, 200, JSON.stringify(hours.body));
  refused(await call(closeRoute, crewHeaders, { params: { id: s.visit.jobId }, body: { status: "completed" } }), 403);
  refused(await call(closeRoute, ownerHeaders, { params: { id: s.visit.jobId }, body: { status: "completed" } }), 409, "VISITS_AHEAD");
  refused(await call(closeRoute, ownerHeaders, { params: { id: s.otherVisit.jobId }, body: { status: "cancelled" } }), 404);
});

withTestDb("schedule routes: a dragged visit moves on the same checks as the form, keeping its length", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");
  await bookVisit(s.owner, { quoteId: s.won.quoteId, memberIds: [s.crewB.memberId], day: s.day, time: "11:00", durationMinutes: 60 }, { post: quiet });
  await addTimeOff(s.owner, { memberId: s.crewB.memberId, day: s.day, start: "15:00", end: "17:00" });
  const length = Date.parse(s.visit.endAt.toISOString()) - Date.parse(s.visit.startAt.toISOString());

  // What the calendar sends for a drop in Lee's lane: the day, the snapped time, and Sam swapped for Lee.
  const drop = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    const move = moveRequest(visitJson(s.visit), s.crewA.memberId, { visitId: s.visit.visitId, date: s.day, memberId: s.crewB.memberId, minute: hours * 60 + minutes }, TZ);
    assert.ok(move);
    assert.deepEqual(move.memberIds, [s.crewB.memberId]);
    return { date: move.date, time: move.time, memberIds: move.memberIds };
  };
  const patch = (headers: Headers, body: Record<string, unknown>) => call(moveRoute, headers, { method: "PATCH", params: { id: s.visit.visitId }, body });

  refused(await patch(crewHeaders, drop("13:00")), 403, "NOT_PRIVILEGED");
  refused(await patch(ownerHeaders, drop("11:30")), 409, "CREW_BUSY");
  refused(await patch(ownerHeaders, drop("15:15")), 409, "CREW_OFF");
  refused(await patch(ownerHeaders, drop("17:30")), 409, "OUTSIDE_HOURS");
  const late = await patch(ownerHeaders, { ...drop("17:30"), allowOutsideHours: true });
  assert.equal(late.status, 200, JSON.stringify(late.body));

  const moved = await patch(ownerHeaders, drop("13:15"));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const visit = moved.body?.visit as { startAt: string; endAt: string; crew: Array<{ name: string }> };
  assert.equal(wallClock(new Date(visit.startAt), TZ).time, "13:15");
  assert.equal(Date.parse(visit.endAt) - Date.parse(visit.startAt), length, "a drag keeps the visit's length");
  assert.deepEqual(visit.crew.map((c) => c.name), ["Lee Crew"]);
});

withTestDb("schedule: a super admin looking sees the owner's view and can't change anything", async () => {
  const s = await seed();
  const headers = await superAdminViewing(TEST_ORG);
  const viewer = await appCaller(headers);
  const page = await scheduleFor(viewer, { view: "week", date: s.day });
  assert.deepEqual(page.visits.map((v) => v.visitId), [s.visit.visitId]);
  assert.equal(page.canManage, false);
  assert.equal(page.me, null);
  refused(await call(bookRoute, headers, { body: { quoteId: s.won.quoteId, memberIds: [s.crewB.memberId], date: s.day, time: "13:00", durationMinutes: 60 } }), 403);
  refused(await call(statusRoute, headers, { params: { id: s.visit.visitId }, body: { status: "cancelled" } }), 403);
});
