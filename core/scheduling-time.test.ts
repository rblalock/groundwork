import assert from "node:assert/strict";
import { test } from "node:test";
import {
  durationText,
  localTimeInstants,
  resolveDay,
  resolveLocalTime,
  weekStart,
  whenText,
  withinWorkingHours,
  workHoursSchema,
  workingSegments,
} from "./scheduling-time";

const NY = "America/New_York";
const sundays = (start: string, end: string) => [{ day: 0, start, end }];

test("a local time resolves in the business's time zone, not the server's", () => {
  assert.equal(resolveLocalTime("2026-10-20", "09:00", NY).toISOString(), "2026-10-20T13:00:00.000Z");
  assert.equal(resolveLocalTime("2026-12-01", "09:00", NY).toISOString(), "2026-12-01T14:00:00.000Z");
  assert.equal(resolveLocalTime("2026-10-20", "09:00", "America/Los_Angeles").toISOString(), "2026-10-20T16:00:00.000Z");
});

test("a time the spring-forward gap skips doesn't exist", () => {
  assert.throws(() => resolveLocalTime("2026-03-08", "02:30", NY), /NONEXISTENT_TIME/);
  assert.deepEqual(localTimeInstants("2026-03-08", "02:30", NY), []);
});

test("a time the fall-back hour repeats needs its offset", () => {
  assert.throws(() => resolveLocalTime("2026-11-01", "01:30", NY), /AMBIGUOUS_TIME/);
  assert.equal(resolveLocalTime("2026-11-01", "01:30", NY, -240).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(resolveLocalTime("2026-11-01", "01:30", NY, -300).toISOString(), "2026-11-01T06:30:00.000Z");
  assert.deepEqual(localTimeInstants("2026-11-01", "01:30", NY).map((d) => d.toISOString()), [
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:30:00.000Z",
  ]);
});

test("malformed days and times are refused", () => {
  assert.throws(() => resolveLocalTime("2026-02-30", "09:00", NY), /INVALID_DATE/);
  assert.throws(() => resolveLocalTime("2026-10-20", "9:00", NY), /INVALID_TIME/);
  assert.throws(() => resolveLocalTime("2026-10-20", "24:00", NY), /INVALID_TIME/);
});

test("working hours: a visit fits only if every minute of it does", () => {
  const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "17:00" }));
  const at = (clock: string) => resolveLocalTime("2026-10-20", clock, NY);
  assert.equal(withinWorkingHours(at("09:00"), at("10:00"), NY, weekdays), true);
  assert.equal(withinWorkingHours(at("16:00"), at("17:00"), NY, weekdays), true);
  assert.equal(withinWorkingHours(at("16:30"), at("17:30"), NY, weekdays), false);
  assert.equal(withinWorkingHours(at("07:45"), at("08:30"), NY, weekdays), false);
  // A gap for lunch splits the day.
  const split = [{ day: 2, start: "08:00", end: "12:00" }, { day: 2, start: "13:00", end: "17:00" }];
  assert.equal(withinWorkingHours(at("11:30"), at("12:30"), NY, split), false);
  // Saturday has no hours.
  const saturday = resolveLocalTime("2026-10-24", "09:00", NY);
  assert.equal(withinWorkingHours(saturday, new Date(saturday.getTime() + 3_600_000), NY, weekdays), false);
});

test("working hours across the clocks changing", () => {
  // Fall back: 00:30 EDT plus two real hours ends 01:30 EST, all inside 00:00-02:00 local.
  const fallStart = new Date("2026-11-01T04:30:00Z");
  const fallEnd = new Date("2026-11-01T06:30:00Z");
  assert.equal(withinWorkingHours(fallStart, fallEnd, NY, sundays("00:00", "02:00")), true);
  assert.equal(withinWorkingHours(fallStart, fallEnd, NY, sundays("00:00", "01:15")), false);
  // Spring forward: 01:30 EST plus one real hour ends 03:30 EDT.
  const springStart = new Date("2026-03-08T06:30:00Z");
  const springEnd = new Date("2026-03-08T07:30:00Z");
  assert.equal(withinWorkingHours(springStart, springEnd, NY, sundays("01:00", "03:00")), false);
  assert.equal(withinWorkingHours(springStart, springEnd, NY, sundays("01:00", "04:00")), true);
});

test("a day said in words becomes a date in the business's time zone", () => {
  const sunday = new Date("2026-10-18T16:00:00Z"); // Sunday noon in New York
  assert.equal(resolveDay("today", NY, sunday), "2026-10-18");
  assert.equal(resolveDay("tomorrow", NY, sunday), "2026-10-19");
  assert.equal(resolveDay("mañana", NY, sunday), "2026-10-19");
  assert.equal(resolveDay("Tuesday", NY, sunday), "2026-10-20");
  assert.equal(resolveDay("next tuesday", NY, sunday), "2026-10-20");
  assert.equal(resolveDay("martes", NY, sunday), "2026-10-20");
  assert.equal(resolveDay("el próximo miércoles", NY, sunday), "2026-10-21");
  assert.equal(resolveDay("Sunday", NY, sunday), "2026-10-25", "said on a Sunday, Sunday is a week out");
  assert.equal(resolveDay("2026-11-03", NY, sunday), "2026-11-03");
  assert.throws(() => resolveDay("someday", NY, sunday), /INVALID_DATE/);
  // 23:30 Sunday in New York is already Monday in UTC; it's still Sunday for the business.
  assert.equal(resolveDay("today", NY, new Date("2026-10-19T03:30:00Z")), "2026-10-18");
});

test("weeks start on Monday", () => {
  assert.equal(weekStart("2026-10-18"), "2026-10-12");
  assert.equal(weekStart("2026-10-19"), "2026-10-19");
  assert.equal(weekStart("2026-10-24"), "2026-10-19");
});

test("hours are checked and merged", () => {
  assert.equal(workHoursSchema.safeParse([{ day: 1, start: "09:00", end: "08:00" }]).success, false);
  assert.equal(workHoursSchema.safeParse([{ day: 1, start: "08:00", end: "12:00" }, { day: 1, start: "11:00", end: "13:00" }]).success, false);
  assert.equal(workHoursSchema.safeParse([{ day: 1, start: "08:00", end: "12:00" }, { day: 1, start: "12:00", end: "17:00" }]).success, true);
  assert.deepEqual(workingSegments("2026-10-19", [{ day: 1, start: "08:00", end: "12:00" }, { day: 1, start: "12:00", end: "17:00" }]), [
    { start: 480, end: 1020 },
  ]);
});

test("visit times read naturally in both languages", () => {
  const start = resolveLocalTime("2026-10-20", "09:00", NY);
  const end = resolveLocalTime("2026-10-20", "10:30", NY);
  assert.equal(whenText(start, end, NY, "en"), "Tue, Oct 20, 9 AM–10:30 AM");
  assert.match(whenText(start, end, NY, "es"), /^mar, 20 de oct, 9 a\.\s?m\.–10:30 a\.\s?m\.$/);
  assert.equal(durationText(90, "en"), "1 hr 30 min");
  assert.equal(durationText(45, "es"), "45 min");
});
