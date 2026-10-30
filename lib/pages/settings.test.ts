import assert from "node:assert/strict";
import { getProfile, updateProfile } from "../../core/profile";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { PATCH as settingsRoute } from "../../app/api/settings/route";
import { settingsFor } from "./settings";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  await person("Sam Crew", "member", "+15555550102");
  await updateProfile(TEST_ORG, { name: "Example Services" }, owner.memberId);
  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  await updateProfile(other, { name: "Other Co", taxRateBp: 500 }, otherOwner.memberId);
  return { other };
}

withTestDb("settings: owners change only what differs; crew and super admins can't change anything", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  await assert.rejects(settingsFor(await appCaller(crewHeaders)), { status: 403 });
  refused(await call(settingsRoute, crewHeaders, { method: "PATCH", body: { taxRateBp: 700 } }), 403, "NOT_PRIVILEGED");
  refused(await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { timeZone: "Mars/Olympus" } }), 400, "INVALID_INPUT");
  refused(await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { quietStartHour: 24 } }), 400);

  const before = await getProfile(TEST_ORG);
  const unchanged = await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { name: "Example Services", taxRateBp: null } });
  assert.deepEqual(unchanged.body?.changed, []);
  assert.equal((await getProfile(TEST_ORG)).version, before.version);

  const saved = await call(settingsRoute, ownerHeaders, {
    method: "PATCH",
    body: { name: "Example Services", taxRateBp: 725, minimumChargeCents: 15000, quietStartHour: 21, timeZone: "America/Chicago", phone: null },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body?.changed, ["timeZone", "quietStartHour", "minimumChargeCents", "taxRateBp"]);
  const after = await getProfile(TEST_ORG);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.taxRateBp, 725);
  assert.equal(after.timeZone, "America/Chicago");
  assert.equal((await getProfile(s.other)).taxRateBp, 500);

  // Drive times: the town speed, road factor, and shortest drive are settings too, with their defaults until changed.
  assert.deepEqual([after.townMph, after.roadFactorBp, after.minDriveMinutes], [28, 13_000, 5]);
  refused(await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { townMph: 2 } }), 400);
  refused(await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { roadFactorBp: 9000 } }), 400);
  const drives = await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { townMph: 25, roadFactorBp: 15_000, minDriveMinutes: 5 } });
  assert.deepEqual(drives.body?.changed, ["townMph", "roadFactorBp"]);
  assert.deepEqual([(await getProfile(TEST_ORG)).townMph, (await getProfile(s.other)).townMph], [25, 28]);

  // A crew's day capacity: 95% until changed, from half the day to all of it.
  assert.equal(after.capacityBp, 9500);
  refused(await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { capacityBp: 12_000 } }), 400);
  const capacity = await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { capacityBp: 9000 } });
  assert.deepEqual(capacity.body?.changed, ["capacityBp"]);
  assert.deepEqual([(await getProfile(TEST_ORG)).capacityBp, (await getProfile(s.other)).capacityBp], [9000, 9500]);

  // Running long: 30 minutes past a stop's finish, 15 past the day's end, a 45-minute lead, until changed.
  assert.deepEqual([after.lateAfterMinutes, after.dayEndGraceMinutes, after.leadMinutes], [30, 15, 45]);
  refused(await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { lateAfterMinutes: 0 } }), 400);
  const late = await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { lateAfterMinutes: 20, dayEndGraceMinutes: 15, leadMinutes: 60 } });
  assert.deepEqual(late.body?.changed, ["lateAfterMinutes", "leadMinutes"]);
  assert.deepEqual([(await getProfile(TEST_ORG)).leadMinutes, (await getProfile(s.other)).leadMinutes], [60, 45]);

  // Weather: 60% rain, 95°F, checked 15 hours before the workday, until changed.
  assert.deepEqual([after.rainThresholdPct, after.heatThresholdF, after.weatherLeadHours], [60, 95, 15]);
  refused(await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { rainThresholdPct: 5 } }), 400);
  const weather = await call(settingsRoute, ownerHeaders, { method: "PATCH", body: { rainThresholdPct: 50, heatThresholdF: 95, weatherLeadHours: 14 } });
  assert.deepEqual(weather.body?.changed, ["rainThresholdPct", "weatherLeadHours"]);
  assert.deepEqual([(await getProfile(TEST_ORG)).rainThresholdPct, (await getProfile(s.other)).rainThresholdPct], [50, 60]);

  const admin = await superAdminViewing(TEST_ORG);
  assert.equal((await settingsFor(await appCaller(admin))).name, "Example Services");
  refused(await call(settingsRoute, admin, { method: "PATCH", body: { taxRateBp: 0 } }), 403, "NOT_A_MEMBER");
});
