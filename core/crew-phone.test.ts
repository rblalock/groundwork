import assert from "node:assert/strict";
import { test } from "node:test";
import { organization } from "../schema/schema";
import { currentStopIndex, declareDelay, mapsUrl, nextAfterDone, nextStop, nextStopIndex, startStop, underWayIndex } from "./crew-phone";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { dayPlans, type DayPlan, type PlanStop } from "./day-plan";
import { createMember, type Caller } from "./members";
import { saveNote } from "./notes";
import { updateProfile } from "./profile";
import type { Poster } from "./quotes";
import { bookVisit, changeVisitStatus } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

const TZ = "America/New_York";
const DATE = "2026-11-03"; // a Tuesday; New York is UTC-5
const local = (clock: string) => new Date(`${DATE}T${clock}:00-05:00`);

const stop = (visitId: string, extra: Partial<PlanStop> = {}) => ({ visitId, startedAt: null, status: "scheduled", ...extra }) as PlanStop;
const planOf = (stops: PlanStop[]) => ({ stops }) as DayPlan;

test("crew phone: the stop under way, the next one, and the one a delay is about", () => {
  const fresh = planOf([stop("v1"), stop("v2")]);
  assert.deepEqual([underWayIndex(fresh), nextStopIndex(fresh), currentStopIndex(fresh)], [-1, 0, 0]);

  const onSite = planOf([stop("v1", { startedAt: local("09:00") }), stop("v2"), stop("v3")]);
  assert.deepEqual([underWayIndex(onSite), nextStopIndex(onSite), currentStopIndex(onSite)], [0, 1, 0]);

  const between = planOf([stop("v1", { status: "completed" }), stop("v2"), stop("v3")]);
  assert.deepEqual([underWayIndex(between), nextStopIndex(between), currentStopIndex(between)], [-1, 1, 1]);

  // A stop skipped and never marked done stays behind them: the next is after the last one they got to.
  const skipped = planOf([stop("v1"), stop("v2", { startedAt: local("10:30") }), stop("v3")]);
  assert.deepEqual([underWayIndex(skipped), nextStopIndex(skipped)], [1, 2]);

  const finished = planOf([stop("v1", { status: "completed" }), stop("v2", { status: "completed" })]);
  assert.deepEqual([underWayIndex(finished), nextStopIndex(finished), currentStopIndex(finished)], [-1, -1, -1]);

  assert.equal(mapsUrl("412 Oak St, Tequesta, FL"), "https://maps.apple.com/?q=412%20Oak%20St%2C%20Tequesta%2C%20FL");
});

async function member(name: string, role: Caller["role"], orgId = TEST_ORG): Promise<Caller> {
  const row = await createMember({ orgId, name, role });
  return { orgId, memberId: row.id, name, role, language: "en", phoneE164: null };
}

withTestDb("crew phone: next, on site, running late, and done re-plan the crew's own day", async () => {
  const post: Poster = async () => ({ posted: true });
  const at = (clock: string) => ({ now: local(clock), post });
  const owner = await member("Pat Ortega", "owner");
  const carlos = await member("Carlos Reyes", "member");
  const ana = await member("Ana Crew", "member");
  await updateProfile(TEST_ORG, { timeZone: TZ, address: "100 Bridge Rd, Tequesta, FL" }, owner.memberId);
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "412 Oak St" }, owner.memberId);
  const pine = await saveCustomer(TEST_ORG, { name: "Pine Customer", address: "7 Pine Ave" }, owner.memberId);
  await saveNote(owner, { title: "Gate code", body: "4321\nDog in the back yard", customerId: maria.id, propertyId: maria.properties[0].id });
  const book = (customer: typeof maria, time: string, minutes: number) =>
    bookVisit(
      owner,
      { title: customer.properties[0].address, customerId: customer.id, propertyId: customer.properties[0].id, memberIds: [carlos.memberId], day: DATE, time, durationMinutes: minutes, visitNotes: customer === maria ? "Side gate" : undefined },
      { now: local("07:00"), post },
    );
  const oak = (await book(maria, "13:00", 60)).visit;
  const pineVisit = (await book(pine, "14:30", 60)).visit;

  const first = await nextStop(carlos, {}, at("12:30"));
  assert.equal(first.stop?.visitId, oak.visitId);
  assert.equal(first.mapsUrl, "https://maps.apple.com/?q=412%20Oak%20St");
  assert.deepEqual(first.siteNotes, ["Gate code: 4321"]);
  assert.equal(first.remaining, 1);
  assert.match(first.text, /^Next: 1 PM 412 Oak St \(Maria Alvarez\)\. About \d+ min from the yard\.\nhttps:\/\/maps\.apple\.com\/\?q=412%20Oak%20St\nNotes: Side gate\nSite notes: Gate code: 4321$/);

  // Ana isn't on it; the owner may start anyone's.
  await assert.rejects(startStop(ana, { visitId: oak.visitId }, at("13:05")), /NOT_ON_VISIT/);
  await assert.rejects(startStop(ana, {}, at("13:05")), /NO_STOP_TODAY/);
  await assert.rejects(declareDelay(ana, { minutes: 30, visitId: oak.visitId }, at("13:05")), /NOT_ON_VISIT/);

  const started = await startStop(carlos, {}, at("13:05"));
  assert.equal(started.visit.visitId, oak.visitId);
  assert.equal(started.visit.startedAt?.toISOString(), local("13:05").toISOString());
  assert.equal(started.text, "On site at 412 Oak St since 1:05 PM, done about 2:05 PM. Next: 2:30 PM 7 Pine Ave.");
  assert.equal((await startStop(carlos, { visitId: oak.visitId }, at("13:10"))).alreadyStarted, true);

  // Still on site at 2:50, past 2:05 plus the 30 minutes: running long, pushing Pine Ave, but back well before 5 PM.
  const owners = await dayPlans(owner, { date: DATE, memberId: carlos.memberId }, at("14:50"));
  const day = owners.plans[0];
  assert.deepEqual([day.replan?.visitId, day.replan?.runningLong, day.stops[1].lateMinutes, day.atRisk], [oak.visitId, true, 25, false]);
  // With no grace past the 5 PM end, still there at 3:50 puts the return past it.
  await updateProfile(TEST_ORG, { dayEndGraceMinutes: 0 }, owner.memberId);
  assert.equal((await dayPlans(owner, { date: DATE }, at("15:50"))).plans[0].atRisk, true);
  assert.equal((await dayPlans(carlos, { date: DATE }, at("15:50"))).plans[0].atRisk, true, "Carlos sees his own day at risk too");
  await updateProfile(TEST_ORG, { dayEndGraceMinutes: 15 }, owner.memberId);

  const delayed = await declareDelay(carlos, { minutes: 30 }, at("13:30"));
  assert.equal(delayed.visit.visitId, oak.visitId, "the delay is on the stop he's on");
  assert.equal(delayed.visit.delayMinutes, 30);
  assert.deepEqual(delayed.shifts.map((s) => s.title), ["7 Pine Ave"]);
  assert.match(delayed.text, /^Noted: 30 min late at 412 Oak St\. Now: 7 Pine Ave about 2:\d\d PM \(\d+ min late\)\. Back at the yard about \d:\d\d PM\./);
  const cleared = await declareDelay(carlos, { minutes: 0 }, at("13:31"));
  assert.match(cleared.text, /^Cleared the delay at 412 Oak St\./);

  const done = await changeVisitStatus(carlos, { visitId: oak.visitId, status: "completed" }, at("14:00"));
  assert.match((await nextAfterDone(carlos, done.visit, at("14:00"))) ?? "", /^Next: 2:30 PM 7 Pine Ave/);
  assert.equal(await nextAfterDone(owner, done.visit, at("14:00")), null, "only someone on the stop hears what's next");
  assert.equal((await nextStop(carlos, {}, at("14:01"))).stop?.visitId, pineVisit.visitId);

  // Running late on the way to Pine Ave puts its arrival after its start.
  const onTheWay = await declareDelay(carlos, { minutes: 30 }, at("14:01"));
  assert.equal(onTheWay.visit.visitId, pineVisit.visitId);
  assert.deepEqual(onTheWay.shifts.map((s) => [s.title, s.lateMinutes]), [["7 Pine Ave", 30]]);
  assert.equal((await startStop(carlos, {}, at("14:40"))).visit.delayMinutes, 0, "on site, the delay on the way is dropped");
  await changeVisitStatus(carlos, { visitId: pineVisit.visitId, status: "completed" }, at("16:00"));
  assert.match((await nextStop(carlos, {}, at("16:01"))).text, /^No more stops today\. Back at the yard about \d:\d\d PM\.$/);
  await assert.rejects(startStop(carlos, {}, at("16:01")), /NO_STOP_TODAY/);

  // Another day's visit isn't started today, and another business's people see none of it.
  const tomorrow = (await bookVisit(owner, { title: "4 Elm Rd", memberIds: [carlos.memberId], day: "2026-11-04", time: "09:00" }, { now: local("07:00"), post })).visit;
  await assert.rejects(startStop(carlos, { visitId: tomorrow.visitId }, at("16:02")), /VISIT_NOT_TODAY/);
  await db().insert(organization).values({ id: "org_other", name: "Other", slug: "other" });
  const stranger = await member("Kim Other", "owner", "org_other");
  await assert.rejects(startStop(stranger, { visitId: tomorrow.visitId }, at("16:02")), /VISIT_NOT_FOUND/);
  assert.equal((await nextStop(stranger, { memberId: carlos.memberId }, at("12:30"))).stop, null);
});
