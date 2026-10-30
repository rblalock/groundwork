import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { followups, organization, proposals } from "../schema/schema";
import { saveCustomer } from "./customers";
import { db } from "./db";
import { addPhone, createMember, recordInbound, type Caller } from "./members";
import { saveItems } from "./pricebook";
import { updateProfile } from "./profile";
import { applyProposal, dropProposal, openProposals, ownerText, proposalForTool, sendProposal } from "./proposals";
import { approveQuote, createQuote, setQuoteOutcome, type Poster } from "./quotes";
import { bookVisit, getVisit, type Slot } from "./scheduling";
import { TEST_ORG, withTestDb } from "./test-db";
import { fakeForecast, type Forecast } from "./weather";
import { buildWeatherProposal, checkWeather, proposeWeatherMoves, weatherCheckAt, weatherTick, type WeatherContext, type WeatherStop } from "./weather-check";

const TZ = "America/New_York";
const TODAY = "2026-11-05"; // a Thursday; New York is UTC-5
const DATE = "2026-11-06"; // the Friday checked
const local = (clock: string, date = DATE) => new Date(`${date}T${clock}:00-05:00`);
const carlos = { memberId: "mem_carlos", name: "Carlos Reyes" };
const ana = { memberId: "mem_ana", name: "Ana Ortega" };
const thresholds = { rainPct: 60, heatF: 95 };

function stop(id: string, title: string, start: string, crew: { memberId: string; name: string }, work: string[], extra: Partial<WeatherStop> = {}): WeatherStop {
  const startAt = local(start);
  return {
    visitId: id,
    title,
    startAt,
    endAt: new Date(startAt.getTime() + 60 * 60_000),
    crew: [crew],
    revision: 2,
    customerName: null,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 10,
    customerLanguage: "en",
    work,
    ...extra,
  };
}

function slot(who: { memberId: string; name: string }, date: string, clock: string): Slot {
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
  };
}

/** The fake's forecast from Thursday 5 PM (rain at 70% Friday 10 AM to 2 PM), with rain at 80% Saturday 9 to 11 AM too. */
function forecast(): Forecast {
  const saturday = [local("09:00", "2026-11-07").getTime(), local("10:00", "2026-11-07").getTime()];
  return fakeForecast(local("17:00", TODAY), TZ).map((h) => (saturday.includes(h.at.getTime()) ? { ...h, rainPct: 80 } : h));
}

const context = (extra: Partial<WeatherContext> = {}): WeatherContext => ({
  now: local("17:00", TODAY),
  today: TODAY,
  date: DATE,
  timeZone: TZ,
  business: "Ortega Lawn",
  language: "en",
  thresholds,
  forecast: forecast(),
  memberLanguages: new Map([[carlos.memberId, "es"]]),
  // Each crew has 9, 11, and 1 o'clock open on every later day.
  slotsFor: async (s, date) => ["09:00", "11:00", "13:00"].map((clock) => slot(s.crew[0], date, clock)),
  ...extra,
});

test("weather check: it runs the lead hours before the next workday starts, 8 AM when the business has no hours that day", () => {
  const hours = [5, 6].map((day) => ({ day, start: "07:00", end: "15:00" }));
  assert.equal(weatherCheckAt({ workHours: hours, timeZone: TZ, weatherLeadHours: 15 }, DATE).toISOString(), local("16:00", TODAY).toISOString(), "4 PM before a 7 AM Friday");
  assert.equal(weatherCheckAt({ workHours: hours, timeZone: TZ, weatherLeadHours: 15 }, "2026-11-08").toISOString(), local("17:00", "2026-11-07").toISOString(), "a Sunday off counts from 8");
  assert.equal(weatherCheckAt({ workHours: hours, timeZone: TZ, weatherLeadHours: 2 }, DATE).toISOString(), local("05:00").toISOString());
});

test("weather check: rain over a stop's window moves it to its crew's next dry slot; dry stops stay", async () => {
  const stops = [
    stop("v_elm", "4 Elm Rd", "15:00", carlos, ["Lawn mowing"]),
    stop("v_oak", "412 Oak St", "10:00", carlos, ["Lawn mowing"], { customerName: "Maria Alvarez", customerLanguage: "es" }),
    stop("v_pine", "7 Pine Ave", "13:00", carlos, ["Lawn mowing"]),
    stop("v_sod", "40 Pine Ave", "11:00", ana, ["Sod installed"], { customerName: "Sam Lee" }),
    stop("v_dawn", "12 Oak St", "08:00", carlos, ["Lawn mowing"]),
  ];
  const built = await buildWeatherProposal(stops, context());
  assert.ok(built);
  assert.equal(built.reason, "Rain likely tomorrow 10 AM–2 PM (70%) over 3 stops (lawn mowing, sod installed)");
  assert.equal(built.atRisk, 3);
  assert.deepEqual(
    built.items.map((i) => [i.id, i.title, i.to.date, i.to.time, i.to.names]),
    [
      ["1", "412 Oak St", "2026-11-07", "11:00", ["Carlos Reyes"]],
      ["2", "40 Pine Ave", "2026-11-07", "11:00", ["Ana Ortega"]],
      ["3", "7 Pine Ave", "2026-11-07", "13:00", ["Carlos Reyes"]],
    ],
    "in time order; Saturday 9 AM is wet too, and 11 AM is Carlos's once 412 Oak St has it",
  );
  assert.equal(built.items[0].revision, 2);
  assert.deepEqual(built.items[0].from.memberIds, [carlos.memberId]);
  assert.equal(
    built.items[0].customerText,
    "Hola Maria, le escribe Ortega Lawn. Como se espera lluvia, movimos su visita en 412 Oak St de vie, 6 de nov a las 10 a.m. a sáb, 7 de nov, 11 a.m.–12 p.m. Avísenos si ese horario no le funciona.",
  );
  assert.equal(
    built.items[1].customerText,
    "Hi Sam, it's Ortega Lawn. With rain likely, we've moved your visit at 40 Pine Ave from Fri, Nov 6 at 11 AM to Sat, Nov 7, 11 AM–12 PM. Reply if that time doesn't work.",
  );
  assert.equal(built.items[0].crewText, "412 Oak St pasa a sáb, 7 de nov, 11 a.m.–12 p.m.", "in Carlos's language");
  assert.equal(built.items[1].crewText, "40 Pine Ave moves to Sat, Nov 7, 11 AM–12 PM.");
  assert.ok(built.items.every((i) => !/\$|\d+\.\d\d/.test(i.customerText)), "no prices");

  const text = ownerText({ kind: "move_weather", date: DATE, reason: built.reason, items: built.items }, null, TZ, "en");
  assert.equal(
    text,
    "Rain likely tomorrow 10 AM–2 PM (70%) over 3 stops (lawn mowing, sod installed).\nMove 3 stops to a dry day?\n1. 412 Oak St → Carlos Sat 11 AM\n2. 40 Pine Ave → Ana Sat 11 AM\n3. 7 Pine Ave → Carlos Sat 1 PM\nReply the numbers to keep, 'all', or 'no'.",
  );
  assert.match(ownerText({ kind: "move_weather", date: DATE, reason: "x", items: built.items.slice(0, 1) }, null, TZ, "es"), /\n¿Muevo 1 parada a un día seco\?\n1\. 412 Oak St → Carlos sáb 11/);
});

test("weather check: heat is its own reason, the work named once, in the business's language; nothing at risk is none", async () => {
  const hot = { rainPct: 60, heatF: 84 };
  const stops = [stop("v_oak", "412 Oak St", "10:00", carlos, ["Lawn mowing"]), stop("v_elm", "4 Elm Rd", "15:00", carlos, ["Lawn mowing"])];
  const built = await buildWeatherProposal(stops, context({ thresholds: hot }));
  assert.equal(built?.reason, "Rain likely tomorrow 10 AM–2 PM (70%) over 1 lawn mowing stop; heat likely tomorrow 3 PM–4 PM (85°F) over 1 lawn mowing stop");
  const es = await buildWeatherProposal(stops.slice(0, 1), context({ language: "es" }));
  assert.match(es!.reason, /^Lluvia probable mañana de 10 a\.\s?m\. a 2 p\.\s?m\. \(70%\) en 1 parada de lawn mowing$/);
  assert.equal(await buildWeatherProposal([stop("v_elm", "4 Elm Rd", "15:00", carlos, ["Lawn mowing"])], context()), null, "a dry afternoon");

  const nowhere = await buildWeatherProposal(stops.slice(0, 1), context({ slotsFor: async () => [] }));
  assert.deepEqual([nowhere?.atRisk, nowhere?.items], [1, []], "at risk with nowhere to go");
  const beyond = await buildWeatherProposal(stops.slice(0, 1), context({ slotsFor: async (s, date) => (date === "2026-11-09" ? [slot(s.crew[0], date, "09:00")] : []) }));
  assert.equal(beyond?.items[0].to.date, "2026-11-09", "past the forecast's reach counts as dry");
});

// ---------------------------------------------------------------------------------------------
// On the database

async function person(name: string, role: Caller["role"], phone: string, language: "en" | "es" = "en"): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role, language });
  const row = await addPhone(TEST_ORG, member.id, phone);
  await recordInbound(TEST_ORG, row.id, `thread:${phone}`, new Date(), "iMessage");
  return { orgId: TEST_ORG, memberId: member.id, name, role, language, phoneE164: phone };
}

/**
 * Ortega Lawn, from the yard at 100 Bridge Rd: Carlos's Friday has mowing at 412 Oak St at 10 (in the fake's rain),
 * hedges at 7 Pine Ave at noon (rain doesn't stop hedges), and mowing at 4 Elm Rd at 3 (dry).
 */
async function rainyFriday() {
  const posts: Array<{ memberId: string; text: string }> = [];
  const post: Poster = async (_orgId, memberId, payload) => {
    posts.push({ memberId, text: payload.text ?? "" });
    return { posted: true };
  };
  const owner = await person("Pat Ortega", "owner", "+15555550101");
  const crew = await person("Carlos Reyes", "member", "+15555550102", "es");
  await updateProfile(TEST_ORG, { name: "Ortega Lawn", timeZone: TZ, address: "100 Bridge Rd, Tequesta, FL" }, owner.memberId);
  const [mowing, hedges] = await saveItems(
    TEST_ORG,
    [
      { name: "Lawn mowing", unitKind: "visit", unitLabel: "visit", priceCents: 6500, weatherSensitive: true },
      { name: "Hedge trimming", unitKind: "other", unitLabel: "cubic foot", priceCents: 250 },
    ],
    owner.memberId,
  );
  const book = async (name: string, address: string, itemId: string, time: string, language: "en" | "es" = "en") => {
    const customer = await saveCustomer(TEST_ORG, { name, address, language }, owner.memberId);
    const quote = await createQuote(
      { title: address, customerId: customer.id, propertyId: customer.properties[0].id, lines: [{ itemId, quantity: 1 }] },
      owner,
      { post },
    );
    await approveQuote(quote.quoteId, owner, { post });
    await setQuoteOutcome(quote.quoteId, "won", owner, { post });
    const booked = await bookVisit(owner, { quoteId: quote.quoteId, memberIds: [crew.memberId], day: DATE, time }, { now: local("07:00", TODAY), post });
    return booked.visit;
  };
  const oak = await book("Maria Alvarez", "412 Oak St", mowing.id, "10:00", "es");
  const pine = await book("Pine Customer", "7 Pine Ave", hedges.id, "12:00");
  const elm = await book("Elm Customer", "4 Elm Rd", mowing.id, "15:00");
  posts.length = 0;
  return { owner, crew, posts, post, visits: { oak, pine, elm } };
}

withTestDb("weather check: the evening before, rain over a mowing stop raises one proposal for the business and texts the owners", async () => {
  const { owner, crew, posts, post, visits } = await rainyFriday();
  assert.equal(await proposeWeatherMoves(TEST_ORG, local("16:30", TODAY)), null, "not before 5 PM (8 AM less 15 hours)");

  const checked = await checkWeather(TEST_ORG, local("17:05", TODAY), { post });
  assert.ok(checked);
  const { proposal, sent } = checked;
  assert.deepEqual([proposal.kind, proposal.memberId, proposal.date, proposal.status], ["move_weather", null, DATE, "open"]);
  assert.equal(proposal.reason, "Rain likely tomorrow 10 AM–2 PM (70%) over 1 lawn mowing stop");
  assert.deepEqual(
    proposal.items.map((i) => [i.visitId, i.to.date, i.to.memberIds]),
    [[visits.oak.visitId, "2026-11-09", [crew.memberId]]],
    "only 412 Oak St: hedges aren't weather-sensitive and 4 Elm Rd is dry; to Carlos's Monday, his next workday",
  );
  assert.deepEqual(sent, ["Pat Ortega"]);
  assert.deepEqual(posts.map((p) => p.memberId), [owner.memberId], "the owners only; nothing reaches the crew or a customer");
  assert.match(posts[0].text, /^Rain likely tomorrow 10 AM–2 PM \(70%\) over 1 lawn mowing stop\.\nMove 1 stop to a dry day\?\n1\. 412 Oak St → Carlos Mon \d{1,2}(:\d{2})? AM\nReply the numbers to keep, 'all', or 'no'\.$/);
  assert.match(proposal.items[0].customerText, /^Hola Maria, le escribe Ortega Lawn\. Como se espera lluvia, movimos su visita en 412 Oak St de vie, 6 de nov a las 10 a\.\s?m\. a lun, 9 de nov,/);

  assert.equal(await checkWeather(TEST_ORG, local("18:05", TODAY), { post }), null, "once per business and day");
  const [open] = (await openProposals(owner, { now: local("18:00", TODAY) })).proposals;
  assert.deepEqual([open.id, open.memberName], [proposal.id, null]);
  const tool = proposalForTool(open, TZ, "en");
  assert.equal(tool.kind, "move_weather");
  assert.ok(!("crew" in tool));
  assert.match(tool.text, /^Rain likely tomorrow/);

  posts.length = 0;
  const applied = await applyProposal(owner, {}, { now: local("18:10", TODAY), post });
  assert.deepEqual(applied.moved.map((m) => m.itemId), ["1"]);
  const moved = await getVisit(owner, visits.oak.visitId);
  assert.equal(moved?.startAt.toISOString(), proposal.items[0].to.startAt);
  assert.deepEqual(applied.customerTexts.map((c) => c.customerName), ["Maria Alvarez"], "a draft to forward");
  assert.ok(posts.every((p) => p.memberId === crew.memberId), "the crew hear of the move, as for any; never a customer");
  assert.match(applied.summaryText, /^Moved 1 stop: 412 Oak St → Carlos Mon /);

  // Applied, it isn't raised again, and a dropped one wouldn't be either.
  assert.equal(await proposeWeatherMoves(TEST_ORG, local("19:00", TODAY)), null);
});

withTestDb("weather check: held by quiet hours, the owners' text is queued for the morning; a dropped proposal stays dropped", async () => {
  const { owner, post } = await rainyFriday();
  const quiet: Poster = async () => ({ posted: false, reason: "quiet_hours" });
  const checked = await checkWeather(TEST_ORG, local("21:00", TODAY), { post: quiet });
  assert.ok(checked);
  assert.deepEqual(checked.sent, []);
  const queued = await db()
    .select()
    .from(followups)
    .where(and(eq(followups.orgId, TEST_ORG), eq(followups.memberId, owner.memberId), eq(followups.kind, "notice")));
  assert.equal(queued.length, 1);
  assert.match(queued[0].payload?.text ?? "", /^Rain likely tomorrow 10 AM–2 PM \(70%\)/);
  assert.equal(queued[0].dueAt.toISOString(), local("07:00").toISOString(), "when quiet hours end");

  await dropProposal(owner, {}, { now: local("21:05", TODAY) });
  assert.equal(await proposeWeatherMoves(TEST_ORG, local("22:00", TODAY)), null);
  assert.deepEqual(await sendProposal(TEST_ORG, checked.proposal, { now: local("09:00", TODAY), post }), ["Pat Ortega"], "sendable as any proposal");
});

withTestDb("weather check: the hourly tick checks every business, and another business's stops are its own", async () => {
  await rainyFriday();
  await db().insert(organization).values({ id: "org_other", name: "Other", slug: "other" });
  assert.equal(await weatherTick(local("17:00", TODAY)), 1, "only the business with weather-sensitive stops");
  const rows = await db().select().from(proposals);
  assert.deepEqual(rows.map((r) => [r.orgId, r.kind]), [[TEST_ORG, "move_weather"]]);
  assert.equal(await weatherTick(local("18:00", TODAY)), 0);
});
