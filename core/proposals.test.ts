import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { organization, proposals } from "../schema/schema";
import { declareDelay, startStop } from "./crew-phone";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { planDay, replanFrom, type DayPlan } from "./day-plan";
import { createMember, type Caller } from "./members";
import { DEFAULT_DRIVE, type Place } from "./places";
import { updateProfile } from "./profile";
import {
  applyProposal,
  buildMoveProposal,
  dropProposal,
  expireProposals,
  openProposals,
  ownerText,
  pickSlot,
  proposeMoves,
  returnWith,
  sendProposal,
  stopsToMove,
  summaryText,
  type BuildContext,
  type MoveContext,
} from "./proposals";
import type { Poster } from "./quotes";
import { checkRunningLong } from "./running-long";
import { addTimeOff, bookVisit, getVisit, setVisitDelay, type Slot, type VisitView } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";

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
    recurrence: null,
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

test("proposals: the summary says what moved, what didn't and why, then the customer drafts to forward", () => {
  const text = summaryText(
    {
      moved: [{ itemId: "1", title: "4 Elm Rd", line: "4 Elm Rd → Pat today 2:30 PM" }],
      skipped: [{ itemId: "2", title: "40 Pine Ave", reason: "that time isn't free anymore" }],
      customerTexts: [{ itemId: "1", customerName: "Maria Alvarez", text: "Hi Maria, …" }],
    },
    "en",
  );
  assert.equal(
    text,
    "Moved 1 stop: 4 Elm Rd → Pat today 2:30 PM. The crew are texted.\n\nNot moved: 40 Pine Ave (that time isn't free anymore).\n\nTexts for the customers, for you to forward:\n\nMaria Alvarez: Hi Maria, …",
  );
  assert.equal(summaryText({ moved: [], skipped: [], customerTexts: [] }, "es"), "No se movió nada.");
});

// ---------------------------------------------------------------------------------------------
// On the database

const T = (clock: string) => local(clock); // Tuesday, Nov 3, in New York

async function member(name: string, role: Caller["role"], orgId = TEST_ORG, language: "en" | "es" = "en"): Promise<Caller> {
  const row = await createMember({ orgId, name, role, language });
  return { orgId, memberId: row.id, name, role, language, phoneE164: null };
}

/**
 * Carlos's Tuesday from the yard at 100 Bridge Rd: 412 Oak St at 8:15, 7 Pine Ave at noon, 4 Elm Rd at 2, 40 Pine Ave at
 * 3:30. He's on site at 412 Oak St from 8:15 and says at 9 it runs six hours over; Pat is off from 3:30 PM.
 */
async function carlosRunsLong() {
  const posts: Array<{ memberId: string; text: string }> = [];
  const post: Poster = async (_orgId, memberId, payload) => {
    posts.push({ memberId, text: payload.text ?? "" });
    return { posted: true };
  };
  const owner = await member("Pat Ortega", "owner");
  const carlos = await member("Carlos Reyes", "member", TEST_ORG, "es");
  await updateProfile(TEST_ORG, { name: "Ortega Lawn", timeZone: TZ, address: "100 Bridge Rd, Tequesta, FL" }, owner.memberId);
  const maria = await saveCustomer(TEST_ORG, { name: "Maria Alvarez", address: "4 Elm Rd", language: "es" }, owner.memberId);
  const book = async (address: string, time: string, minutes: number) => {
    const customer = address === "4 Elm Rd" ? maria : await saveCustomer(TEST_ORG, { name: `Customer at ${address}`, address }, owner.memberId);
    const booked = await bookVisit(
      owner,
      { title: address, customerId: customer.id, propertyId: customer.properties[0].id, memberIds: [carlos.memberId], day: DATE, time, durationMinutes: minutes },
      { now: T("07:00"), post },
    );
    return booked.visit;
  };
  const oakVisit = await book("412 Oak St", "08:15", 90);
  const pineVisit = await book("7 Pine Ave", "12:00", 60);
  const elmVisit = await book("4 Elm Rd", "14:00", 60);
  const farVisit = await book("40 Pine Ave", "15:30", 60);
  await addTimeOff(owner, { memberId: owner.memberId, day: DATE, start: "15:30", end: "17:00", reason: "dentist" }, { now: T("07:00") });
  await startStop(carlos, { visitId: oakVisit.visitId }, { now: T("08:15") });
  await declareDelay(carlos, { minutes: 360, visitId: oakVisit.visitId }, { now: T("09:00") });
  // Declaring the delay raised the proposal at once; these tests raise it themselves from the ten-minute check.
  await db().delete(proposals).where(eq(proposals.orgId, TEST_ORG));
  const plans: DayPlan[] = [];
  await checkRunningLong(TEST_ORG, T("09:10"), async (_orgId, plan) => void plans.push(plan));
  assert.equal(plans.length, 1, "Carlos's day is at risk");
  posts.length = 0;
  return { owner, carlos, plan: plans[0], posts, post, visits: { oakVisit, pineVisit, elmVisit, farVisit } };
}

withTestDb("proposals: a day at risk raises one proposal, once, and texts the owners a numbered confirm", async () => {
  const { owner, carlos, plan, posts, post, visits } = await carlosRunsLong();
  const proposal = await proposeMoves(TEST_ORG, plan, { now: T("09:10") });
  assert.ok(proposal);
  assert.equal(proposal.status, "open");
  assert.equal(proposal.memberId, carlos.memberId);
  assert.match(proposal.reason, /^Carlos is running \d+ min late at 412 Oak St; the day would end at \d{1,2}:\d{2} PM$/);
  assert.deepEqual(
    proposal.items.map((i) => [i.id, i.visitId, i.to.date === DATE ? "today" : "later", i.to.memberIds]),
    [
      ["1", visits.elmVisit.visitId, "today", [owner.memberId]],
      ["2", visits.farVisit.visitId, "later", [carlos.memberId]],
    ],
    "the last two stops: 4 Elm Rd to Pat at its time, 40 Pine Ave (Pat is off then) to Carlos's next day with room",
  );
  assert.equal(proposal.items[0].to.time, "14:00");
  assert.equal(proposal.items[0].revision, visits.elmVisit.revision);
  assert.match(proposal.items[1].customerText, /^Hi Customer, it's Ortega Lawn\. We're running behind today, so we've moved your visit at 40 Pine Ave from today at 3:30 PM to /);
  assert.equal(await proposeMoves(TEST_ORG, plan, { now: T("09:20") }), null, "one per member and day");

  assert.deepEqual(await sendProposal(TEST_ORG, proposal, { now: T("09:10"), post }), ["Pat Ortega"], "owners and admins only; not Carlos");
  assert.equal(posts.length, 1);
  const [text] = posts.map((p) => p.text);
  assert.match(text, /\nMove 2 stops for Carlos\?\n1\. 4 Elm Rd → Pat today 2 PM\n2\. 40 Pine Ave → Carlos (tomorrow|Wed|Thu) \d{1,2}(:\d{2})? AM\nReply the numbers to keep, 'all', or 'no'\.$/);

  assert.equal((await openProposals(owner, { now: T("09:10") })).proposals.length, 1);
  assert.deepEqual((await openProposals(carlos, { now: T("09:10") })).proposals, [], "crew see none");
  await assert.rejects(applyProposal(carlos, { proposalId: proposal.id }, { now: T("09:15"), post }), /NOT_PRIVILEGED/);
  await db().insert(organization).values({ id: "org_other", name: "Other", slug: "other" });
  const stranger = await member("Other Owner", "owner", "org_other");
  await assert.rejects(applyProposal(stranger, { proposalId: proposal.id }, { now: T("09:15"), post }), /PROPOSAL_NOT_FOUND/, "another business's proposal isn't there");

  posts.length = 0;
  const applied = await applyProposal(owner, {}, { now: T("09:15"), post });
  assert.deepEqual(applied.moved.map((m) => m.itemId), ["1", "2"], "the only open one, all of it");
  assert.deepEqual(applied.skipped, []);
  assert.equal(applied.proposal.status, "applied");
  assert.deepEqual(applied.proposal.appliedItemIds, ["1", "2"]);
  assert.equal(applied.proposal.decidedByMemberId, owner.memberId);
  const elm = await getVisit(owner, visits.elmVisit.visitId);
  assert.deepEqual([elm?.crew.map((c) => c.name), elm?.startAt.toISOString()], [["Pat Ortega"], T("14:00").toISOString()]);
  const far = await getVisit(owner, visits.farVisit.visitId);
  assert.deepEqual([far?.crew.map((c) => c.name), far?.startAt.toISOString()], [["Carlos Reyes"], proposal.items[1].to.startAt]);
  assert.deepEqual(applied.customerTexts.map((c) => c.customerName), ["Maria Alvarez", "Customer at 40 Pine Ave"], "drafts only");
  assert.ok(posts.every((p) => p.memberId === carlos.memberId), "the crew are texted, as for any move; never a customer");
  assert.ok(posts.some((p) => /te quitó de 4 Elm Rd/.test(p.text)), "Carlos hears 4 Elm Rd is off his day, in Spanish");
  assert.match(applied.summaryText, /^Moved 2 stops: 4 Elm Rd → Pat today 2 PM; 40 Pine Ave → Carlos .+\. The crew are texted\.\n\nTexts for the customers, for you to forward:\n\nMaria Alvarez: Hola Maria/);
  await assert.rejects(applyProposal(owner, { proposalId: proposal.id }, { now: T("09:20"), post }), /PROPOSAL_CLOSED: it was applied/);
});

withTestDb("proposals: applying re-checks each stop: a slot taken since, or a visit changed since, is skipped with why", async () => {
  const { owner, carlos, plan, posts, post, visits } = await carlosRunsLong();
  const proposal = (await proposeMoves(TEST_ORG, plan, { now: T("09:10") }))!;
  // Pat takes something at 2 PM in the meantime, and 40 Pine Ave gets a delay (a new revision).
  const other = await saveCustomer(TEST_ORG, { name: "Oak Neighbor", address: "12 Oak St" }, owner.memberId);
  await bookVisit(owner, { title: "12 Oak St", customerId: other.id, propertyId: other.properties[0].id, memberIds: [owner.memberId], day: DATE, time: "14:00" }, { now: T("09:11"), post });
  const kept = await applyProposal(owner, { proposalId: proposal.id, itemIds: ["1"] }, { now: T("09:15"), post });
  assert.deepEqual(kept.moved, []);
  assert.deepEqual(kept.skipped, [{ itemId: "1", title: "4 Elm Rd", reason: "that time isn't free anymore" }]);
  assert.deepEqual(kept.proposal.appliedItemIds, []);
  assert.equal(kept.summaryText, "Nothing moved.\n\nNot moved: 4 Elm Rd (that time isn't free anymore).");
  const elm = await getVisit(owner, visits.elmVisit.visitId);
  assert.deepEqual([elm?.crew.map((c) => c.memberId), elm?.revision], [[carlos.memberId], visits.elmVisit.revision], "it stays as it was");

  // A second day's proposal, for the revision check: raised again after the first was decided would be refused, so
  // this one is made by hand from the first's items.
  const [again] = await db()
    .insert(proposals)
    .values({ id: "prop_again", orgId: TEST_ORG, kind: "move_stops", memberId: carlos.memberId, date: DATE, reason: proposal.reason, items: proposal.items })
    .returning();
  await setVisitDelay(owner, { visitId: visits.farVisit.visitId, minutes: 10 }, { now: T("09:20") });
  const changed = await applyProposal(owner, { proposalId: again.id, itemIds: ["2"] }, { now: T("09:25"), post });
  assert.deepEqual(changed.skipped, [{ itemId: "2", title: "40 Pine Ave", reason: "it changed since the proposal" }]);
  await assert.rejects(applyProposal(owner, { proposalId: again.id, itemIds: ["7"] }, { now: T("09:25"), post }), /PROPOSAL_CLOSED/);
  assert.deepEqual(posts.filter((p) => p.memberId === carlos.memberId && /movió|quitó/.test(p.text)), [], "nothing moved, so nobody heard of a move");
});

withTestDb("proposals: dropping moves nothing, an unknown stop is refused, and a proposal's day over expires it", async () => {
  const { owner, plan, post, visits } = await carlosRunsLong();
  const proposal = (await proposeMoves(TEST_ORG, plan, { now: T("09:10") }))!;
  await assert.rejects(applyProposal(owner, { proposalId: proposal.id, itemIds: ["9"] }, { now: T("09:15"), post }), /PROPOSAL_ITEM_NOT_FOUND/);
  const dropped = await dropProposal(owner, {}, { now: T("09:15") });
  assert.equal(dropped.proposal.status, "dropped");
  assert.equal(dropped.summaryText, "OK, nothing moves: the 2 stops stay as booked.");
  assert.equal((await getVisit(owner, visits.elmVisit.visitId))?.revision, visits.elmVisit.revision);
  await assert.rejects(dropProposal(owner, { proposalId: proposal.id }, { now: T("09:16") }), /PROPOSAL_CLOSED: it was dropped/);
  await assert.rejects(dropProposal(owner, {}, { now: T("09:16") }), /PROPOSAL_NOT_FOUND/, "none open");

  await db().insert(proposals).values({ id: "prop_old", orgId: TEST_ORG, kind: "move_stops", memberId: owner.memberId, date: DATE, reason: "x", items: [] });
  await assert.rejects(applyProposal(owner, { proposalId: "prop_old" }, { now: local("08:00", "2026-11-04"), post }), /PROPOSAL_EXPIRED/);
  assert.equal(await expireProposals(TEST_ORG, local("09:00")), 0, "not while its day lasts");
  assert.equal(await expireProposals(TEST_ORG, local("00:05", "2026-11-04")), 1);
  const [old] = await db().select().from(proposals).where(eq(proposals.id, "prop_old"));
  assert.equal(old.status, "expired");
});
