import assert from "node:assert/strict";
import { test } from "node:test";
import { organization } from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { dayEndAt, dayPlans, planDay, planForTool, replanFrom, routeLine, type PlanInput } from "./day-plan";
import { createMember, type Caller } from "./members";
import { DEFAULT_DRIVE, type Place } from "./places";
import { updateProfile } from "./profile";
import type { Poster } from "./quotes";
import { bookVisit, type VisitView } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

const TZ = "America/New_York";
const at = (lat: number, lng: number, label: string): Place => ({ lat, lng, label });
const yard = at(26.9, -80.1, "100 Bridge Rd");
// A twentieth of a degree apart going north from the yard: 10 minutes between neighbors.
const oak = at(26.95, -80.1, "412 Oak St");
const pine = at(27.0, -80.1, "7 Pine Ave");
const elm = at(27.05, -80.1, "4 Elm Rd");
const carlos = { memberId: "mem_carlos", name: "Carlos Reyes" };
const DATE = "2026-11-03"; // a Tuesday; New York is UTC-5
const local = (clock: string) => new Date(`${DATE}T${clock}:00-05:00`);

function visit(id: string, place: Place | null, start: string, end: string, extra: Partial<VisitView> = {}): VisitView {
  return {
    visitId: id,
    jobId: `sj_${id}`,
    title: place?.label ?? "Unplaced Ln",
    jobStatus: "open",
    customerId: null,
    customerName: null,
    address: place?.label ?? "Unplaced Ln",
    propertyId: null,
    place,
    quoteId: null,
    crew: [carlos],
    startAt: local(start),
    endAt: local(end),
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 10,
    status: "scheduled",
    startedAt: null,
    completedAt: null,
    delayMinutes: 0,
    notes: null,
    revision: 1,
    checklist: null,
    ...extra,
  };
}

const input = (visits: VisitView[], extra: Partial<PlanInput> = {}): PlanInput => ({
  ...carlos,
  date: DATE,
  hours: [{ day: 2, start: "08:00", end: "16:00" }],
  yard,
  settings: DEFAULT_DRIVE,
  capacityBp: 9500,
  visits,
  ...extra,
});

const clock = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null); // UTC: 13:00 is 8 AM in New York

test("day plan: stops in booked order, the drive into each, leaving the yard and getting back", () => {
  const plan = planDay(
    input([
      visit("v2", pine, "10:30", "11:30"),
      visit("v1", oak, "09:00", "10:00", { checklist: { done: 1, total: 3 } }),
      visit("vx", elm, "13:00", "14:00", { status: "cancelled" }),
    ]),
  );
  assert.deepEqual(plan.stops.map((s) => s.title), ["412 Oak St", "7 Pine Ave"]);
  assert.deepEqual(plan.stops[0].legIn, { minutes: 10, label: "100 Bridge Rd", yard: true });
  assert.deepEqual(plan.stops[1].legIn, { minutes: 10, label: "412 Oak St", yard: false });
  assert.deepEqual(plan.legOut, { minutes: 20, label: "100 Bridge Rd", yard: true });
  assert.equal(clock(plan.leaveYardAt), "13:50", "8:50 AM: the first start less the drive in");
  assert.equal(clock(plan.stops[1].plannedArriveAt), "15:10", "10:10 AM: the first stop's end plus the drive");
  assert.equal(plan.stops[1].lateMinutes, 0);
  assert.equal(clock(plan.backAtYardAt), "16:50", "11:50 AM: the last end plus the drive back");
  assert.deepEqual(plan.stops[0].checklist, { done: 1, total: 3 });
  assert.deepEqual([plan.driveMinutes, plan.workMinutes, plan.dayMinutes], [40, 120, 480]);
  assert.equal(plan.load, 3333, "160 of 480 minutes");
  assert.equal(plan.overCapacity, false);
  assert.deepEqual(plan.unplaced, []);
  assert.equal(plan.suggestedOrder, null);
});

test("day plan: a stop reached after its start is late, and its finish moves with it", () => {
  const plan = planDay(input([visit("v1", oak, "09:00", "10:00"), visit("v2", elm, "10:10", "11:00")]));
  assert.equal(plan.stops[1].legIn?.minutes, 20);
  assert.equal(plan.stops[1].lateMinutes, 10);
  assert.equal(clock(plan.stops[1].plannedLeaveAt), "16:10", "11:10 AM");
  assert.equal(clock(plan.backAtYardAt), "16:40", "11:40 AM: thirty minutes back from Elm Rd");
});

test("day plan: an unplaced stop has no drive in or out, and the day's ends still count what's known", () => {
  const plan = planDay(input([visit("v1", oak, "09:00", "10:00"), visit("v2", null, "11:00", "12:00"), visit("v3", pine, "13:00", "14:00")]));
  assert.deepEqual(plan.stops.map((s) => s.legIn?.minutes ?? null), [10, null, null]);
  assert.deepEqual(plan.unplaced, ["Unplaced Ln"]);
  assert.equal(plan.driveMinutes, 10 + 20);
  assert.equal(clock(plan.leaveYardAt), "13:50");
  assert.equal(clock(plan.backAtYardAt), "19:20", "2:20 PM");
  assert.equal(plan.suggestedOrder, null, "nothing is suggested when a stop can't be placed");

  const noYard = planDay(input([visit("v1", oak, "09:00", "10:00")], { yard: null }));
  assert.deepEqual([noYard.leaveYardAt, noYard.backAtYardAt, noYard.stops[0].legIn, noYard.legOut], [null, null, null, null]);
  assert.equal(noYard.yardPlaced, false);
});

test("day plan: load is work plus driving over the working day, against the capacity", () => {
  const long = planDay(input([visit("v1", oak, "08:10", "15:40")]));
  assert.equal(long.load, 9792);
  assert.equal(long.overCapacity, true, "97.9% is over 95%");
  assert.equal(planDay(input([visit("v1", oak, "08:10", "15:40")], { capacityBp: 10_000 })).overCapacity, false);
  const off = planDay(input([visit("v1", oak, "09:00", "10:00")], { hours: [] }));
  assert.deepEqual([off.dayMinutes, off.load, off.overCapacity], [0, null, false]);
});

test("day plan: a shorter order is suggested when it saves ten minutes or more", () => {
  const zigzag = planDay(input([visit("v1", pine, "08:30", "09:00"), visit("v2", oak, "09:30", "10:00"), visit("v3", elm, "11:00", "11:30")]));
  assert.equal(zigzag.driveMinutes, 20 + 10 + 20 + 30);
  assert.deepEqual(zigzag.suggestedOrder?.map((s) => s.title), ["412 Oak St", "7 Pine Ave", "4 Elm Rd"]);
  assert.equal(zigzag.savedDriveMinutes, 20);

  const inOrder = planDay(input([visit("v1", oak, "08:30", "09:00"), visit("v2", pine, "09:30", "10:00"), visit("v3", elm, "11:00", "11:30")]));
  assert.deepEqual([inOrder.suggestedOrder, inOrder.savedDriveMinutes], [null, null]);

  const underWay = planDay(input([visit("v1", pine, "08:30", "09:00", { status: "completed" }), visit("v2", oak, "09:30", "10:00"), visit("v3", elm, "11:00", "11:30")]));
  assert.equal(underWay.suggestedOrder, null, "a day under way isn't reordered");
});

test("route line: each stop's start, title, and drive in, between leaving the yard and getting back", () => {
  const plan = planDay(input([visit("v1", oak, "09:00", "10:00"), visit("v2", null, "10:30", "11:00"), visit("v3", pine, "11:30", "12:00")]));
  assert.equal(routeLine(plan, TZ, "en"), "leave the yard 8:50 AM → 9 AM 412 Oak St (10 min) → 10:30 AM Unplaced Ln → 11:30 AM 7 Pine Ave → back by 12:20 PM");
  assert.equal(routeLine(plan, TZ, "es"), "sales de la base 8:50 a.m. → 9 a.m. 412 Oak St (10 min) → 10:30 a.m. Unplaced Ln → 11:30 a.m. 7 Pine Ave → de vuelta a las 12:20 p.m.");

  const tool = planForTool(plan, TZ, "en");
  assert.deepEqual([tool.leaveYardAt, tool.backAtYardAt, tool.driveMinutes, tool.loadPercent, tool.capacityPercent], ["08:50", "12:20", 30, 31, 95]);
  assert.deepEqual(tool.unplaced, ["Unplaced Ln"]);
  assert.match(tool.line, /^Carlos Reyes, Tue, Nov 3: leave the yard 8:50 AM → /);
});

const settings = (end: string | null, extra: { lateAfterMinutes?: number; graceMinutes?: number } = {}) => ({
  lateAfterMinutes: 30,
  graceMinutes: 15,
  dayEndAt: end ? local(end) : null,
  ...extra,
});

test("re-plan: nothing started, done, or delayed leaves the day as booked", () => {
  const plan = planDay(input([visit("v1", oak, "09:00", "10:00"), visit("v2", pine, "10:30", "11:30")]));
  const same = replanFrom(plan, local("09:30"), settings("16:00"));
  assert.equal(same.replan, null);
  assert.equal(same.atRisk, false);
  assert.deepEqual(same.stops, plan.stops);
});

test("re-plan: a stop under way past its finish pushes the stops after it, and slack takes it up", () => {
  const visits = (extra = {}) => [
    visit("v1", oak, "09:00", "10:00", { startedAt: local("09:00"), ...extra }),
    visit("v2", pine, "10:30", "11:30"),
    visit("v3", elm, "13:00", "14:00"),
  ];
  const plan = replanFrom(planDay(input(visits())), local("10:40"), settings("16:00"));
  assert.equal(clock(plan.stops[0].plannedLeaveAt), "15:40", "10:40 AM: not done, so it runs at least until now");
  assert.equal(clock(plan.stops[1].plannedArriveAt), "15:50", "10:50 AM: now plus the 10-minute drive");
  assert.equal(plan.stops[1].lateMinutes, 20);
  assert.equal(clock(plan.stops[1].plannedLeaveAt), "16:50");
  assert.equal(plan.stops[2].lateMinutes, 0, "the gap before 1 PM takes up the rest");
  assert.equal(clock(plan.backAtYardAt), "19:30", "2:30 PM, as booked");
  assert.deepEqual([plan.replan?.visitId, plan.replan?.runningLong, plan.replan?.shiftMinutes], ["v1", true, 0]);
  assert.equal(plan.atRisk, false, "the return doesn't move");
  assert.match(routeLine(plan, TZ, "en"), /10:30 AM 7 Pine Ave \(10 min\), 20 min late → 1 PM 4 Elm Rd/);
  assert.match(routeLine(plan, TZ, "es"), /7 Pine Ave \(10 min\), 20 min tarde/);

  const early = replanFrom(planDay(input(visits())), local("10:20"), settings("16:00"));
  assert.equal(early.replan?.runningLong, false, "twenty minutes past is under the 30-minute mark");
  assert.equal(replanFrom(planDay(input(visits())), local("10:20"), settings("16:00", { lateAfterMinutes: 20 })).replan?.runningLong, true);
});

test("re-plan: running long into the end of the day puts it at risk", () => {
  const visits = [visit("v1", oak, "13:00", "14:00", { startedAt: local("13:05") }), visit("v2", pine, "14:10", "15:30")];
  const booked = planDay(input(visits));
  assert.equal(clock(booked.backAtYardAt), "20:50", "3:50 PM");
  const plan = replanFrom(booked, local("14:50"), settings("16:00"));
  assert.equal(clock(plan.stops[0].plannedLeaveAt), "19:50", "2:50 PM");
  assert.equal(plan.stops[0].lateMinutes, 5, "started five minutes after its booked start");
  assert.equal(plan.stops[1].lateMinutes, 50);
  assert.equal(clock(plan.backAtYardAt), "21:40", "4:40 PM");
  assert.deepEqual([plan.replan?.shiftMinutes, clock(plan.replan?.latestBackAt ?? null)], [50, "21:15"]);
  assert.equal(plan.atRisk, true, "past 4 PM plus 15 minutes, later than booked, and running long");

  const notYet = replanFrom(booked, local("14:20"), settings("16:00"));
  assert.deepEqual([notYet.replan?.runningLong, notYet.replan?.shiftMinutes, notYet.atRisk], [false, 20, false], "pushed, but not running long yet");
  assert.equal(replanFrom(booked, local("14:50"), settings("16:00", { graceMinutes: 60 })).atRisk, false, "an hour's grace covers it");
  assert.equal(replanFrom(booked, local("14:50"), settings(null)).atRisk, false, "no hours, no workday end to pass");
});

test("re-plan: a done stop leaves when it was marked done, and a declared delay moves the next arrival", () => {
  const visits = (extra = {}) => [visit("v1", oak, "09:00", "10:00", { status: "completed", completedAt: local("10:20") }), visit("v2", pine, "10:30", "11:30", extra)];
  const done = replanFrom(planDay(input(visits(), { hours: [{ day: 2, start: "08:00", end: "12:00" }] })), local("10:25"), settings("12:00"));
  assert.equal(clock(done.stops[1].plannedArriveAt), "15:30", "10:30 AM: done at 10:20 plus the drive");
  assert.deepEqual([done.stops[1].lateMinutes, done.replan?.runningLong, done.atRisk], [0, false, false]);

  const delayed = replanFrom(planDay(input(visits({ delayMinutes: 30 }), { hours: [{ day: 2, start: "08:00", end: "12:00" }] })), local("10:25"), settings("12:00"));
  assert.equal(clock(delayed.stops[1].plannedArriveAt), "16:00", "11 AM: thirty minutes after its booked start");
  assert.equal(delayed.stops[1].lateMinutes, 30);
  assert.equal(clock(delayed.backAtYardAt), "17:20", "12:20 PM");
  assert.deepEqual([delayed.replan?.visitId, delayed.replan?.runningLong, delayed.replan?.shiftMinutes, delayed.atRisk], ["v2", true, 30, true]);

  const early = replanFrom(planDay(input([visit("v1", oak, "09:00", "10:00", { status: "completed", completedAt: local("09:40") }), visit("v2", pine, "10:30", "11:30")])), local("09:45"), settings("16:00"));
  assert.equal(clock(early.stops[1].plannedArriveAt), "14:50", "9:50 AM: early, so they wait for 10:30");
  assert.equal(clock(early.stops[1].plannedLeaveAt), "16:30", "11:30 AM, as booked");
  assert.equal(early.stops[1].lateMinutes, 0);
});

test("re-plan: a delay on the stop under way moves its finish, and the day's end is the last working stretch", () => {
  const visits = [visit("v1", oak, "09:00", "10:00", { startedAt: local("09:00"), delayMinutes: 20 }), visit("v2", pine, "10:10", "11:00")];
  const plan = replanFrom(planDay(input(visits)), local("09:30"), settings("16:00"));
  assert.equal(clock(plan.stops[0].plannedLeaveAt), "15:20", "10:20 AM: its finish plus the delay, though now is earlier");
  assert.equal(plan.stops[1].lateMinutes, 20);
  assert.equal(plan.replan?.runningLong, true);
  assert.equal(plan.suggestedOrder, null);

  assert.equal(dayEndAt(DATE, [{ day: 2, start: "08:00", end: "12:00" }, { day: 2, start: "13:00", end: "17:00" }], TZ)?.toISOString(), "2026-11-03T22:00:00.000Z");
  assert.equal(dayEndAt(DATE, [{ day: 1, start: "08:00", end: "16:00" }], TZ), null, "Tuesday is a day off");
});

async function member(name: string, role: Caller["role"], orgId = TEST_ORG): Promise<Caller> {
  const row = await createMember({ orgId, name, role });
  return { orgId, memberId: row.id, name, role, language: "en", phoneE164: null };
}

withTestDb("day plans: owners see every crew member's route, crew only their own, and never another business's", async () => {
  const post: Poster = async () => ({ posted: true });
  const deps = { now: new Date("2026-11-02T13:00:00Z"), post }; // Monday 8 AM in New York
  const owner = await member("Pat Ortega", "owner");
  const crew = await member("Carlos Reyes", "member");
  const helper = await member("Ana Crew", "member");
  await updateProfile(TEST_ORG, { timeZone: TZ, address: "100 Bridge Rd, Tequesta, FL" }, owner.memberId);
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "412 Oak St" }, owner.memberId);
  const pine = await saveCustomer(TEST_ORG, { name: "Pine Customer", address: "7 Pine Ave" }, owner.memberId);
  const book = (who: Caller, customer: typeof maria, time: string) =>
    bookVisit(owner, { title: customer.properties[0].address, customerId: customer.id, propertyId: customer.properties[0].id, memberIds: [who.memberId], day: DATE, time }, deps);
  await book(crew, maria, "09:00");
  await book(crew, pine, "11:00");
  await book(helper, pine, "09:00");

  const all = await dayPlans(owner, { date: DATE }, deps);
  assert.deepEqual(all.plans.map((p) => [p.name, p.stops.length]), [["Carlos Reyes", 2], ["Ana Crew", 1]]);
  const carlos = all.plans[0];
  assert.equal(carlos.stops[0].legIn?.yard, true);
  assert.equal(carlos.stops[1].legIn?.label, "412 Oak St");
  assert.ok(carlos.leaveYardAt && carlos.backAtYardAt);
  assert.equal(carlos.capacityBp, 9500);
  assert.equal(routeLine(carlos, TZ, "en").split(" → ").length, 4);

  const mine = await dayPlans(crew, { date: DATE, memberId: helper.memberId }, deps);
  assert.deepEqual(mine.plans.map((p) => p.name), ["Carlos Reyes"], "crew get their own route, whoever they ask for");
  assert.deepEqual((await dayPlans(owner, { date: DATE, memberId: helper.memberId }, deps)).plans.map((p) => p.name), ["Ana Crew"]);

  await db().insert(organization).values({ id: "org_other", name: "Other", slug: "other" });
  const stranger = await member("Kim Other", "owner", "org_other");
  assert.deepEqual((await dayPlans(stranger, { date: DATE }, deps)).plans, []);
});
