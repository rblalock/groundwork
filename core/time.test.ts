import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, isQuietHours, localParts, nextAllowedTime, todayYmd } from "./time";

test("quiet hours wrap midnight", () => {
  const tz = "America/New_York";
  assert.equal(isQuietHours(new Date("2026-10-16T03:00:00Z"), tz, 20, 7), true);  // 23:00 local
  assert.equal(isQuietHours(new Date("2026-10-16T15:00:00Z"), tz, 20, 7), false); // 11:00 local
});
test("nextAllowedTime moves a 23:00 due time to 07:00 next morning", () => {
  const out = nextAllowedTime(new Date("2026-10-16T03:00:00Z"), "America/New_York", 20, 7);
  assert.deepEqual(localParts(out, "America/New_York"), { ymd: "2026-10-16", hour: 7, minute: 0, weekday: 5 });
});
test("nextAllowedTime returns the input when not quiet", () => {
  const d = new Date("2026-10-16T15:00:00Z");
  assert.equal(nextAllowedTime(d, "America/New_York", 20, 7).getTime(), d.getTime());
});
test("nextAllowedTime rolls to the next day after the evening start", () => {
  const out = nextAllowedTime(new Date("2026-10-17T01:30:00Z"), "America/New_York", 20, 7);
  assert.deepEqual(localParts(out, "America/New_York"), { ymd: "2026-10-17", hour: 7, minute: 0, weekday: 6 });
});
test("nextAllowedTime handles the DST fall-back night", () => {
  const out = nextAllowedTime(new Date("2026-11-01T05:30:00Z"), "America/New_York", 20, 7); // 01:30 EDT
  assert.deepEqual(localParts(out, "America/New_York"), { ymd: "2026-11-01", hour: 7, minute: 0, weekday: 0 });
});
test("non-wrapping window", () => {
  const tz = "America/New_York";
  assert.equal(isQuietHours(new Date("2026-10-16T15:00:00Z"), tz, 9, 17), true);
  assert.equal(isQuietHours(new Date("2026-10-16T22:00:00Z"), tz, 9, 17), false);
});
test("addDays and todayYmd", () => {
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(todayYmd("America/New_York", new Date("2026-10-16T03:00:00Z")), "2026-10-15");
});
