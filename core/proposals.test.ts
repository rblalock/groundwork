import assert from "node:assert/strict";
import { test } from "node:test";
import { planDay, replanFrom, type DayPlan } from "./day-plan";
import { DEFAULT_DRIVE, type Place } from "./places";
import { buildMoveProposal, ownerText, pickSlot, returnWith, stopsToMove, type BuildContext, type MoveContext } from "./proposals";
import type { Slot, VisitView } from "./scheduling";

const TZ = "America/New_York";
const DATE = "2026-11-03"; // a Tuesday; New York is UTC-5
const local = (clock: string, date = DATE) => new Date(`${date}T${clock}:00-05:00`);
const at = (lat: number, lng: number, label: string): Place => ({ lat, lng, label });
// A twentieth of a degree apart going north from the yard: 10 minutes between neighbors.
const yard = at(26.9, -80.1, "100 Bridge Rd");
const oak = at(26.95, -80.1, "412 Oak St");
const pine = at(27.0, -80.1, "7 Pine Ave");
const elm = at(27.05, -80.1, "4 Elm Rd");
const far = at(27.1, -80.1, "40 Pine Ave");
const carlos = { memberId: "mem_carlos", name: "Carlos Reyes" };
const pat = { memberId: "mem_pat", name: "Pat Ortega" };

function visit(id: string, place: Place, start: string, end: string, extra: Partial<VisitView> = {}): VisitView {
  return {
    visitId: id,
    jobId: `sj_${id}`,
    title: place.label,
    jobStatus: "open",
    customerId: null,
    customerName: null,
    address: place.label,
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
    revision: 3,
    checklist: null,
    ...extra,
  };
}

/** Carlos's Tuesday: on site at 412 Oak St since 8, saying it runs `delay` minutes over, then three more stops. */
function carlosDay(delay: number, now: Date): DayPlan {
  const booked = planDay({
    ...carlos,
    date: DATE,
    hours: [{ day: 2, start: "08:00", end: "16:00" }],
    yard,
    settings: DEFAULT_DRIVE,
    capacityBp: 9500,
    visits: [
      visit("v1", oak, "08:00", "09:30", { startedAt: local("08:00"), delayMinutes: delay }),
      visit("v2", pine, "12:00", "13:00"),
      visit("v3", elm, "13:30", "14:30"),
      visit("v4", far, "14:45", "15:30"),
    ],
  });
  return replanFrom(booked, now, { lateAfterMinutes: 30, graceMinutes: 15, dayEndAt: local("16:00") });
}

const moveContext = (now: Date, extra: Partial<MoveContext> = {}): MoveContext => ({
  now,
  leadMinutes: 45,
  latestBackAt: local("16:15"),
  yard,
  settings: DEFAULT_DRIVE,
  ...extra,
});

function slot(who: { memberId: string; name: string }, date: string, clock: string, extra: Partial<Slot> = {}): Slot {
  const startAt = local(clock, date);
  return {
    date,
    start: clock,
    end: "",
    startAt,
    endAt: new Date(startAt.getTime() + 60 * 60_000),
    offsetMinutes: -300,
    crew: [who],
    driveFromPreviousMinutes: 10,
    driveToNextMinutes: 10,
    driveEstimated: true,
    addedDriveMinutes: 20,
    fits: true,
    ...extra,
  };
}

test("proposals: the last stops not started come off, latest first, until the return fits the day's end and grace", () => {
  const now = local("11:00");
  const small = carlosDay(200, now);
  assert.equal(small.atRisk, true);
  assert.deepEqual(stopsToMove(small, moveContext(now)).map((s) => s.visitId), ["v4"], "one off the end is enough");

  const big = carlosDay(270, now);
  const moved = stopsToMove(big, moveContext(now));
  assert.deepEqual(moved.map((s) => s.visitId), ["v3", "v4"], "in day order");
  assert.ok(returnWith(big, 2, yard, DEFAULT_DRIVE)! <= local("16:15"), "with the first two the crew are back in time");
  assert.ok(returnWith(big, 3, yard, DEFAULT_DRIVE)! > local("16:15"), "and not with three");

  const fits = carlosDay(0, now);
  assert.deepEqual(stopsToMove(fits, moveContext(now)), [], "a day that fits moves nothing");
});

test("proposals: a stop within the lead time stays, with everything before it; a stop the crew reached never moves", () => {
  const now = local("12:50");
  const plan = carlosDay(270, now);
  assert.deepEqual(stopsToMove(plan, moveContext(now)).map((s) => s.visitId), ["v4"], "4 Elm Rd starts at 1:30, within 45 minutes: it stays");
  assert.deepEqual(stopsToMove(plan, moveContext(now, { leadMinutes: 30 })).map((s) => s.visitId), ["v3", "v4"], "with a 30-minute lead it can go");
  assert.deepEqual(stopsToMove(plan, moveContext(now, { latestBackAt: local("08:30") })).map((s) => s.visitId), ["v4"], "however late the return, nothing before a stop within the lead");
  const reached = carlosDay(270, local("08:10"));
  assert.deepEqual(stopsToMove(reached, moveContext(local("08:10"), { latestBackAt: local("08:30"), leadMinutes: 0 })).map((s) => s.visitId), ["v2", "v3", "v4"], "never the stop under way");
});

test("proposals: a slot today is someone else's that fits, from the earliest time on; later, the first day with room", () => {
  const claimed = new Map([[pat.memberId, [{ startAt: local("14:00"), endAt: local("15:00") }]]]);
  const input = { memberId: carlos.memberId, date: DATE, earliest: local("13:30"), claimed };
  const today = [
    slot(carlos, DATE, "15:00"),
    slot(pat, DATE, "13:00"),
    slot(pat, DATE, "14:15"),
    slot(pat, DATE, "15:30", { fits: false }),
    slot(pat, DATE, "15:15"),
  ];
  assert.equal(pickSlot(today, "today", input)?.start, "15:15", "not Carlos's own, not before 1:30, not over time already given, not over capacity");
  const later = [slot(carlos, "2026-11-06", "08:00"), slot(carlos, "2026-11-05", "09:00"), slot(carlos, "2026-11-04", "08:00", { fits: false })];
  assert.equal(pickSlot(later, "later", input)?.date, "2026-11-05", "the earliest day with a slot that fits, though a later one ranks first");
  assert.equal(pickSlot([], "today", input), null);
});

test("proposals: the builder numbers the stops, places each, and drafts the texts with no prices", async () => {
  const now = local("11:00");
  const plan = carlosDay(270, now);
  const asked: string[] = [];
  const ctx: BuildContext = {
    ...moveContext(now),
    timeZone: TZ,
    business: "Ortega Lawn",
    language: "en",
    visits: new Map([
      ["v3", { revision: 3, crew: [carlos], customerName: "Maria Alvarez", customerLanguage: "es", bufferBeforeMinutes: 10, bufferAfterMinutes: 10 }],
      ["v4", { revision: 5, crew: [carlos], customerName: null, customerLanguage: "en", bufferBeforeMinutes: 10, bufferAfterMinutes: 10 }],
    ]),
    memberLanguages: new Map([[pat.memberId, "en"], [carlos.memberId, "es"]]),
    slotsFor: async (stop, scope) => {
      asked.push(`${stop.visitId}:${scope}`);
      if (scope === "today") return [slot(pat, DATE, "14:30", { driveFromPreviousMinutes: 15, driveToNextMinutes: 20 }), slot(pat, DATE, "15:00")];
      return [slot(carlos, "2026-11-06", "08:00"), slot(carlos, "2026-11-05", "09:00")];
    },
  };
  const built = await buildMoveProposal(plan, ctx);
  assert.ok(built);
  assert.deepEqual(asked, ["v3:today", "v4:today", "v4:later"], "later days only when nobody can take it today");
  const [first, second] = built.items;
  assert.deepEqual(
    built.items.map((i) => [i.id, i.visitId, i.revision, i.to.date, i.to.time, i.to.memberIds]),
    [
      ["1", "v3", 3, DATE, "14:30", [pat.memberId]],
      ["2", "v4", 5, "2026-11-05", "09:00", [carlos.memberId]],
    ],
    "Pat takes 4 Elm Rd today; 2:30 is then Pat's, so 40 Pine Ave goes to Carlos's next day with room",
  );
  assert.deepEqual([first.to.bufferBeforeMinutes, first.to.bufferAfterMinutes], [15, 20], "the drives around the new slot");
  assert.deepEqual(first.from, { startAt: local("13:30").toISOString(), endAt: local("14:30").toISOString(), memberIds: [carlos.memberId] });
  assert.match(built.reason, /^Carlos is running \d+ min late at 412 Oak St; the day would end at \d{1,2}:\d{2} PM$/);
  assert.equal(
    first.customerText,
    "Hola Maria, le escribe Ortega Lawn. Hoy vamos con retraso, así que movimos su visita en 4 Elm Rd de hoy a las 1:30 p.m. a hoy, 2:30 p.m.–3:30 p.m. Avísenos si ese horario no le funciona.",
    "in Maria's Spanish",
  );
  assert.equal(second.customerText, "Hi, it's Ortega Lawn. We're running behind today, so we've moved your visit at 40 Pine Ave from today at 2:45 PM to Thu, Nov 5, 9 AM–10 AM. Reply if that time doesn't work.");
  assert.equal(first.crewText, "You're on 4 Elm Rd: today, 2:30 PM–3:30 PM, in place of Carlos.");
  assert.equal(second.crewText, "40 Pine Ave pasa a jue, 5 de nov, 9 a.m.–10 a.m.", "in Carlos's Spanish");
  for (const item of built.items) assert.doesNotMatch(item.customerText + item.crewText, /\$|\d+\.\d{2}\b/, "no prices");

  assert.equal(
    ownerText({ date: DATE, reason: "Carlos is running 270 min late at 412 Oak St; the day would end at 5:10 PM", items: built.items }, "Carlos Reyes", TZ, "en"),
    "Carlos is running 270 min late at 412 Oak St; the day would end at 5:10 PM.\nMove 2 stops for Carlos?\n1. 4 Elm Rd → Pat today 2:30 PM\n2. 40 Pine Ave → Carlos Thu 9 AM\nReply the numbers to keep, 'all', or 'no'.",
  );
  assert.match(ownerText({ date: DATE, reason: "x", items: built.items.slice(0, 1) }, "Carlos Reyes", TZ, "es"), /¿Muevo 1 parada de Carlos\?\n1\. 4 Elm Rd → Pat hoy 2:30/);

  const none = await buildMoveProposal(plan, { ...ctx, slotsFor: async () => [] });
  assert.equal(none, null, "no stop with anywhere to go: no proposal");
});
