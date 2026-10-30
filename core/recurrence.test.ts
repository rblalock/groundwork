import assert from "node:assert/strict";
import { test } from "node:test";
import { nextOccurrence, nextOccurrenceFrom, recurrenceText, weekOfMonth } from "./recurrence";

const TZ = "America/New_York";
/** A New York wall clock as an instant: `-04:00` in summer time, `-05:00` in winter. */
const at = (ymd: string, clock: string, offset: "-04:00" | "-05:00") => new Date(`${ymd}T${clock}:00${offset}`);
const next = (every: "week" | "two_weeks" | "month", after: Date, extra: { weekday?: number; time?: string } = {}) => {
  const found = nextOccurrence({ every, ...extra }, after, TZ);
  return [found.date, found.time, found.startAt.toISOString()];
};

test("recurrence: every week is the same weekday a week on, at the same local clock across a clock change", () => {
  assert.deepEqual(next("week", at("2026-11-03", "09:00", "-05:00")), ["2026-11-10", "09:00", "2026-11-10T14:00:00.000Z"]);
  // New York falls back on Sunday, Nov 1, 2026: 9 AM is 13:00 UTC before it and 14:00 after.
  assert.deepEqual(next("week", at("2026-10-27", "09:00", "-04:00")), ["2026-11-03", "09:00", "2026-11-03T14:00:00.000Z"], "fall back");
  // It springs forward on Sunday, Mar 14, 2027.
  assert.deepEqual(next("week", at("2027-03-09", "09:00", "-05:00")), ["2027-03-16", "09:00", "2027-03-16T13:00:00.000Z"], "spring forward");
  assert.deepEqual(next("week", at("2026-11-03", "09:00", "-05:00"), { time: "13:30" }), ["2026-11-10", "13:30", "2026-11-10T18:30:00.000Z"], "the recurrence's clock");
});

test("recurrence: a weekday set apart from the last visit's is the first one after it; every two weeks skips a week", () => {
  const tuesday = at("2026-11-03", "09:00", "-05:00");
  assert.deepEqual(next("week", tuesday, { weekday: 4 }).slice(0, 2), ["2026-11-05", "09:00"], "Tuesday's route day moved to Thursday");
  assert.deepEqual(next("week", tuesday, { weekday: 1 }).slice(0, 2), ["2026-11-09", "09:00"]);
  assert.deepEqual(next("two_weeks", tuesday).slice(0, 2), ["2026-11-17", "09:00"]);
  assert.deepEqual(next("two_weeks", tuesday, { weekday: 4 }).slice(0, 2), ["2026-11-12", "09:00"]);
  assert.deepEqual(next("two_weeks", at("2026-12-29", "09:00", "-05:00")).slice(0, 2), ["2027-01-12", "09:00"], "over the new year");
});

test("recurrence: every month is the same weekday of the month, the last one when the month has no 5th", () => {
  assert.equal(weekOfMonth("2026-11-10"), 2);
  assert.equal(weekOfMonth("2026-09-29"), 5);
  assert.deepEqual(next("month", at("2026-11-10", "09:00", "-05:00")).slice(0, 2), ["2026-12-08", "09:00"], "2nd Tuesday to 2nd Tuesday");
  assert.deepEqual(next("month", at("2026-12-01", "09:00", "-05:00")).slice(0, 2), ["2027-01-05", "09:00"], "into the next year");
  assert.deepEqual(next("month", at("2026-09-29", "09:00", "-04:00")).slice(0, 2), ["2026-10-27", "09:00"], "October has four Tuesdays");
  assert.deepEqual(next("month", at("2027-01-31", "09:00", "-05:00")).slice(0, 2), ["2027-02-28", "09:00"], "the 5th Sunday of January to February's last");
  assert.deepEqual(next("month", at("2026-10-20", "09:00", "-04:00")), ["2026-11-17", "09:00", "2026-11-17T14:00:00.000Z"], "across the fall back");
});

test("recurrence: a clock the spring-forward gap skips is an hour on; missed occurrences are passed over", () => {
  assert.deepEqual(next("week", at("2027-03-07", "02:30", "-05:00")), ["2027-03-14", "02:30", "2027-03-14T07:30:00.000Z"], "3:30 AM summer time");
  const late = nextOccurrenceFrom({ every: "week" }, at("2026-11-03", "09:00", "-05:00"), TZ, at("2026-11-18", "08:00", "-05:00"));
  assert.equal(late.date, "2026-11-24", "the 10th and 17th went by");
  const sameDay = nextOccurrenceFrom({ every: "week" }, at("2026-11-03", "09:00", "-05:00"), TZ, at("2026-11-10", "08:59", "-05:00"));
  assert.equal(sameDay.date, "2026-11-10", "still to come that morning");
});

test("recurrence: the line says how often, which day, and when, in either language", () => {
  assert.equal(recurrenceText({ every: "week", weekday: 2, time: "09:00" }, "en"), "Every week on Tuesdays at 9 AM");
  assert.equal(recurrenceText({ every: "two_weeks", weekday: 5, time: "13:30" }, "en"), "Every two weeks on Fridays at 1:30 PM");
  assert.equal(recurrenceText({ every: "month", weekday: 2, time: "09:00" }, "en", "2026-11-10"), "Every month on the 2nd Tuesday at 9 AM");
  assert.equal(recurrenceText({ every: "month", weekday: 2, time: "09:00" }, "en"), "Every month on a Tuesday at 9 AM");
  assert.equal(recurrenceText({ every: "week" }, "en"), "Every week", "work with no visit booked yet");
  assert.match(recurrenceText({ every: "week", weekday: 6, time: "09:00" }, "es"), /^Cada semana, los sábados a las 9 a\.\s?m\.$/);
  assert.match(recurrenceText({ every: "month", weekday: 2, time: "09:00" }, "es", "2026-11-10"), /^Cada mes, el 2\.º martes a las 9 a\.\s?m\.$/);
});
