import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { memberPhones } from "../schema/schema";
import { db } from "../core/db";
import { findMemberByPhone, listMembers, setPhoneStatus } from "../core/members";
import { listOrganizations } from "../core/organizations";
import type { PhotonAdmin } from "../core/photon-admin";
import { getProfile } from "../core/profile";
import { withTestDb } from "../core/test-db";
import { provision, provisionSchema } from "../core/provision";

const fakeAdmin = (): PhotonAdmin & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async ensureSharedUser({ e164 }) {
      calls.push(e164);
      return { id: `pu_${e164}`, e164, assignedLine: "+15555550100" };
    },
    async removeSharedUser() {
      return true;
    },
  };
};

const minimal = provisionSchema.parse({
  profile: { name: "Example Services LLC", timeZone: "America/Chicago" },
  owner: { name: "Pat Example", phone: "(555) 555-0142" },
});

const orgCount = async () => (await listOrganizations()).length;

withTestDb("provision with only name, time zone, and owner creates the business, its profile, and the owner's line", async () => {
  const admin = fakeAdmin();
  const before = await orgCount();
  const { org, rows } = await provision(minimal, { admin });
  assert.deepEqual(rows, [{ name: "Pat Example", role: "owner", phone: "+15555550142", assignedLine: "+15555550100" }]);
  assert.equal(await orgCount(), before + 1);
  assert.equal(org.name, "Example Services LLC");
  assert.equal(org.slug, "example-services-llc");
  const profile = await getProfile(org.id);
  assert.equal(profile.name, "Example Services LLC");
  assert.equal(profile.timeZone, "America/Chicago");
  assert.equal(profile.quoteValidityDays, 30);
  const found = await findMemberByPhone("+15555550142");
  assert.ok(found);
  assert.equal(found.member.orgId, org.id);
  assert.equal(found.member.role, "owner");
  assert.equal(found.member.addedByMemberId, null);
  assert.equal(found.phone.orgId, org.id);
  assert.equal(found.phone.status, "pending");
  assert.equal(found.phone.photonUserId, "pu_+15555550142");
  assert.equal(found.phone.assignedLine, "+15555550100");
});

withTestDb("optional members are created in the business with the owner as addedBy", async () => {
  const config = provisionSchema.parse({
    ...minimal,
    profile: { ...minimal.profile, quoteValidityDays: 14, language: "es" },
    members: [
      { name: "Sam Crew", role: "member", phone: "555-555-0143" },
      { name: "Alex Admin", role: "admin", phone: "+15555550144", email: "alex@example.test" },
    ],
  });
  const { org, rows } = await provision(config, { admin: fakeAdmin() });
  assert.deepEqual(
    rows.map((r) => [r.name, r.role, r.phone]),
    [
      ["Pat Example", "owner", "+15555550142"],
      ["Sam Crew", "member", "+15555550143"],
      ["Alex Admin", "admin", "+15555550144"],
    ],
  );
  const owner = (await findMemberByPhone("+15555550142"))!.member;
  const sam = (await findMemberByPhone("+15555550143"))!.member;
  assert.equal(sam.addedByMemberId, owner.id);
  assert.equal(sam.role, "member");
  assert.equal(sam.orgId, org.id);
  const profile = await getProfile(org.id);
  assert.equal(profile.quoteValidityDays, 14);
  assert.equal(profile.language, "es");
});

withTestDb("rerunning provision is idempotent, finds the business by its phones, and keeps verified phones verified", async () => {
  const config = provisionSchema.parse({
    ...minimal,
    members: [{ name: "Sam Crew", role: "member", phone: "+15555550143" }],
  });
  const first = await provision(config, { admin: fakeAdmin() });
  const owner = (await findMemberByPhone("+15555550142"))!;
  await setPhoneStatus(first.org.id, owner.phone.id, "verified");
  const before = await orgCount();
  // A renamed business is still the same one: its owner's phone finds it.
  const renamed = provisionSchema.parse({ ...config, profile: { ...config.profile, name: "Example Services Group" } });
  const again = await provision(renamed, { admin: fakeAdmin() });
  assert.equal(again.org.id, first.org.id);
  assert.equal(again.org.name, "Example Services Group");
  assert.equal(again.org.slug, "example-services-llc");
  assert.equal(await orgCount(), before);
  assert.equal(again.rows.length, 2);
  assert.equal((await listMembers(first.org.id)).length, 2);
  assert.equal((await db().select().from(memberPhones)).length, 2);
  assert.equal((await findMemberByPhone("+15555550142"))!.phone.status, "verified");
  assert.equal((await findMemberByPhone("+15555550143"))!.phone.status, "pending");
});

withTestDb("a second business is provisioned alongside the first, and a phone can't join two", async () => {
  const a = await provision(minimal, { admin: fakeAdmin() });
  const other = provisionSchema.parse({
    orgSlug: "sample-co",
    profile: { name: "Sample Co", timeZone: "America/Los_Angeles" },
    owner: { name: "Lee Sample", phone: "+15555550150" },
  });
  const b = await provision(other, { admin: fakeAdmin() });
  assert.notEqual(b.org.id, a.org.id);
  assert.equal(b.org.slug, "sample-co");
  assert.equal((await getProfile(b.org.id)).timeZone, "America/Los_Angeles");
  assert.equal((await getProfile(a.org.id)).timeZone, "America/Chicago");
  assert.deepEqual((await listMembers(b.org.id)).map((m) => m.name), ["Lee Sample"]);

  // Business A's owner phone listed for business B: refused before anything is written.
  const before = await orgCount();
  const stolen = provisionSchema.parse({ ...other, members: [{ name: "Pat Again", role: "member", phone: "+15555550142" }] });
  await assert.rejects(provision(stolen, { admin: fakeAdmin() }), /different businesses/);
  const fresh = provisionSchema.parse({ ...other, orgSlug: "third-co", owner: { name: "Pat Again", phone: "+15555550142" } });
  await assert.rejects(provision(fresh, { admin: fakeAdmin() }), /another business/);
  assert.equal(await orgCount(), before);
  assert.equal((await findMemberByPhone("+15555550142"))!.member.orgId, a.org.id);
  assert.deepEqual((await listMembers(b.org.id)).map((m) => m.name), ["Lee Sample"]);
});

withTestDb("a new business whose name makes a slug in use needs its own orgSlug", async () => {
  await provision(minimal, { admin: fakeAdmin() });
  const sameName = provisionSchema.parse({ ...minimal, owner: { name: "Kim Other", phone: "+15555550160" } });
  await assert.rejects(provision(sameName, { admin: fakeAdmin() }), /example-services-llc.*orgSlug/);
  assert.equal(await findMemberByPhone("+15555550160"), null);
  const { org } = await provision(provisionSchema.parse({ ...sameName, orgSlug: "example-services-two" }), {
    admin: fakeAdmin(),
  });
  assert.equal(org.slug, "example-services-two");
  assert.equal((await findMemberByPhone("+15555550160"))!.member.orgId, org.id);
});

withTestDb("createOnly refuses a business whose slug or owner phone exists, and creates a new one", async () => {
  const first = await provision(minimal, { admin: fakeAdmin(), createOnly: true });
  const before = await orgCount();
  await assert.rejects(provision(minimal, { admin: fakeAdmin(), createOnly: true }), /already belongs to a business/);
  const sameSlug = provisionSchema.parse({ ...minimal, owner: { name: "Kim Other", phone: "+15555550160" } });
  await assert.rejects(provision(sameSlug, { admin: fakeAdmin(), createOnly: true }), /slug "example-services-llc" already exists/);
  const named = provisionSchema.parse({ ...sameSlug, orgSlug: first.org.slug });
  await assert.rejects(provision(named, { admin: fakeAdmin(), createOnly: true }), /already exists/);
  assert.equal(await orgCount(), before);
  assert.equal(await findMemberByPhone("+15555550160"), null);
  const { org } = await provision(provisionSchema.parse({ ...sameSlug, orgSlug: "kim-co" }), { admin: fakeAdmin(), createOnly: true });
  assert.equal(org.slug, "kim-co");
  assert.equal((await getProfile(org.id)).name, "Example Services LLC");
});

test("provision.example.json validates", () => {
  const parsed = provisionSchema.parse(JSON.parse(readFileSync("provision.example.json", "utf8")));
  assert.equal(parsed.members.length, 0);
  assert.equal(parsed.profile.timeZone, "America/New_York");
});

test("validation rejects a bad time zone, a bad phone, and a duplicate phone", () => {
  const base = { profile: { name: "X", timeZone: "America/New_York" }, owner: { name: "O", phone: "+15555550142" } };
  assert.throws(() => provisionSchema.parse({ ...base, profile: { name: "X", timeZone: "Mars/Base" } }));
  assert.throws(() => provisionSchema.parse({ ...base, owner: { name: "O", phone: "123" } }));
  assert.throws(() =>
    provisionSchema.parse({ ...base, members: [{ name: "Dup", role: "member", phone: "555-555-0142" }] }),
  );
  assert.throws(() => provisionSchema.parse({ ...base, profile: { name: "X" } }));
  assert.throws(() => provisionSchema.parse({ ...base, orgSlug: "Not A Slug" }));
  assert.equal(provisionSchema.parse({ ...base, orgSlug: "x-2" }).orgSlug, "x-2");
});
