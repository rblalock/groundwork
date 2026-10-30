import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_DRIVE, driveMinutes, geocode, haversineMeters, legsAround, placesFake, setGeocoderForTests, yardOf, type Place } from "./places";

afterEach(() => setGeocoderForTests(null));

const at = (lat: number, lng: number, label = "here"): Place => ({ lat, lng, label });

test("haversine: a degree of latitude is about 111 km, and a point is no distance from itself", () => {
  assert.ok(Math.abs(haversineMeters(at(26.9, -80.1), at(27.9, -80.1)) - 111_195) < 1);
  assert.equal(haversineMeters(at(26.9, -80.1), at(26.9, -80.1)), 0);
  const east = haversineMeters(at(26.9, -80.1), at(26.9, -79.1));
  assert.ok(east < 100_000 && east > 98_000, "a degree of longitude is shorter away from the equator");
});

test("drive minutes: straight line times the road factor at the town speed, rounded up to 5", () => {
  const yard = at(26.9, -80.1);
  const tenthNorth = at(27.0, -80.1); // 11.1 km in a straight line
  assert.equal(driveMinutes(yard, tenthNorth), 20, "14.5 km of road at 28 mph is 19.3 minutes");
  assert.equal(driveMinutes(tenthNorth, yard), 20, "the same both ways");
  assert.equal(driveMinutes(yard, tenthNorth, { ...DEFAULT_DRIVE, townMph: 25 }), 25, "21.6 minutes at 25 mph");
  assert.equal(driveMinutes(yard, tenthNorth, { ...DEFAULT_DRIVE, roadFactorBp: 10_000 }), 15, "14.8 minutes on a straight road");
  assert.ok(Number.isInteger(driveMinutes(yard, at(26.95, -80.03))));
});

test("drive minutes: never under the minimum, never over a buffer's limit, and nothing to the same place", () => {
  const yard = at(26.9, -80.1);
  assert.equal(driveMinutes(yard, at(26.901, -80.1)), 5, "next door is still the minimum");
  assert.equal(driveMinutes(yard, at(26.901, -80.1), { ...DEFAULT_DRIVE, minDriveMinutes: 10 }), 10);
  assert.equal(driveMinutes(yard, at(36.9, -80.1)), 480);
  assert.equal(driveMinutes(yard, at(26.9, -80.1)), 0);
});

test("legs around a visit: from the stop before or the yard, to the stop after or back to the yard", () => {
  const yard = at(26.934, -80.129, "100 Bridge Rd");
  const oak = at(26.9617, -80.0942, "412 Oak St");
  const pine = at(26.9452, -80.0815, "7 Pine Ave");
  const nine = new Date("2026-10-20T13:00:00Z");
  const eleven = new Date("2026-10-20T15:00:00Z");
  const one = new Date("2026-10-20T17:00:00Z");

  const alone = legsAround({ startAt: eleven, place: oak }, [], yard);
  assert.deepEqual(alone.before, { minutes: driveMinutes(yard, oak), label: "100 Bridge Rd", yard: true });
  assert.deepEqual(alone.after, { minutes: driveMinutes(oak, yard), label: "100 Bridge Rd", yard: true });
  assert.equal(alone.before?.minutes, 10);

  const between = legsAround(
    { startAt: eleven, place: oak },
    [
      { startAt: one, place: pine },
      { startAt: nine, place: at(26.976, -80.1105, "4 Elm Rd") },
      { startAt: new Date("2026-10-20T12:00:00Z"), place: yard },
    ],
    yard,
  );
  assert.equal(between.before?.label, "4 Elm Rd", "the latest stop before, not the first of the day");
  assert.equal(between.before?.yard, false);
  assert.equal(between.after?.label, "7 Pine Ave");
  assert.equal(between.after?.minutes, driveMinutes(oak, pine));
});

test("legs around a visit: an unplaced end is left out, never guessed", () => {
  const yard = at(26.934, -80.129, "100 Bridge Rd");
  const oak = at(26.9617, -80.0942, "412 Oak St");
  const nine = new Date("2026-10-20T13:00:00Z");
  const eleven = new Date("2026-10-20T15:00:00Z");
  assert.deepEqual(legsAround({ startAt: eleven, place: null }, [], yard), { before: null, after: null });
  assert.deepEqual(legsAround({ startAt: eleven, place: oak }, [], null), { before: null, after: null });
  const afterUnplaced = legsAround({ startAt: eleven, place: oak }, [{ startAt: nine, place: null }], yard);
  assert.equal(afterUnplaced.before, null, "the stop before couldn't be placed: not the yard instead");
  assert.equal(afterUnplaced.after?.yard, true);
});

test("the yard is placed only with an address and a point", () => {
  assert.deepEqual(yardOf({ address: "100 Bridge Rd", yardLat: 26.9, yardLng: -80.1 }), { lat: 26.9, lng: -80.1, label: "100 Bridge Rd" });
  assert.equal(yardOf({ address: "100 Bridge Rd", yardLat: null, yardLng: null }), null);
  assert.equal(yardOf({ address: null, yardLat: 26.9, yardLng: -80.1 }), null);
});

test("tests geocode with the fake: fixed points for the seeded addresses, nothing for the rest", async () => {
  assert.equal(process.env.PLACES_FAKE, "1");
  assert.equal(placesFake(), true);
  const oak = await geocode("412 Oak St");
  assert.deepEqual(oak, { lat: 26.9617, lng: -80.0942, label: "412 Oak St, Tequesta, FL 33469" });
  assert.deepEqual(await geocode("412 oak st., Tequesta FL"), oak, "the same address with its town");
  assert.notDeepEqual(await geocode("12 Oak St"), oak);
  assert.equal(await geocode("999 Nowhere Ln"), null);
  assert.equal(await geocode("   "), null);
});

test("the fake is the default locally, never in production, and PLACES_FAKE=0 asks the real geocoder", () => {
  const saved = { fake: process.env.PLACES_FAKE, vercel: process.env.VERCEL_ENV };
  const set = (fake: string | undefined, vercel: string | undefined) => {
    if (fake === undefined) delete process.env.PLACES_FAKE;
    else process.env.PLACES_FAKE = fake;
    if (vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = vercel;
  };
  try {
    set(undefined, undefined);
    assert.equal(placesFake(), true);
    set("0", undefined);
    assert.equal(placesFake(), false);
    set(undefined, "preview");
    assert.equal(placesFake(), false);
    set("1", "preview");
    assert.equal(placesFake(), true);
    set("1", "production");
    assert.equal(placesFake(), false);
  } finally {
    set(saved.fake, saved.vercel);
  }
});

test("a geocoder that fails throws from geocode, for the caller to record", async () => {
  setGeocoderForTests(async () => {
    throw new Error("timeout");
  });
  await assert.rejects(geocode("412 Oak St"), /timeout/);
});
