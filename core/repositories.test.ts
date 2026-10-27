import { test } from "node:test";
import assert from "node:assert/strict";
import { memberConversationForSession, threadFor, upsertThread } from "./conversations";
import { TEST_ORG, withTestDb } from "./test-db";
import { getProfile, updateProfile } from "./profile";
import {
  addPhone,
  createMember,
  findMemberByPhone,
  listMembers,
  normalizeE164,
  reactivateMember,
  recordInbound,
  removeMember,
  resolveCaller,
} from "./members";
import { recordEvent } from "./events";
import { db } from "./db";
import { pricebookChanges } from "../schema/schema";
import { listItems, listRules, retireRule, saveItems, saveItemsWithOutcome, saveRule, updateItem, versions } from "./pricebook";
import { getCustomer, saveCustomer, searchCustomers } from "./customers";

withTestDb("getProfile creates the default row once", async () => {
  const a = await getProfile(TEST_ORG);
  const b = await getProfile(TEST_ORG);
  assert.equal(a.orgId, TEST_ORG);
  assert.equal(a.name, "This business");
  assert.equal(a.version, b.version);
  assert.equal(a.quoteValidityDays, 30);
});

withTestDb("updateProfile bumps version and records an event", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const p = await updateProfile(TEST_ORG, { taxRateBp: 700, minimumChargeCents: 15000 }, owner.id);
  assert.equal(p.version, 2);
  assert.equal(p.taxRateBp, 700);
});

withTestDb("phones map to members and verify on first inbound", async () => {
  const m = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member" });
  const ph = await addPhone(TEST_ORG, m.id, "+13055550142");
  assert.equal((await findMemberByPhone("+13055550142"))?.member.id, m.id);
  await recordInbound(TEST_ORG, ph.id, "imessage:x:x", new Date());
  assert.equal((await findMemberByPhone("+13055550142"))?.phone.status, "verified");
});

test("normalizeE164", () => {
  assert.equal(normalizeE164("(305) 555-0142"), "+13055550142");
  assert.equal(normalizeE164("+1 305 555 0142"), "+13055550142");
  assert.equal(normalizeE164("12"), null);
});

withTestDb("resolveCaller maps principals", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const photon = (attributes: Record<string, unknown>) =>
    resolveCaller({ authenticator: "photon-imessage", principalId: "x", attributes });
  const caller = await photon({ orgId: TEST_ORG, memberId: owner.id });
  assert.equal(caller?.role, "owner");
  assert.equal(caller?.orgId, TEST_ORG);
  // The member id must be in the org the principal names, and both are required.
  assert.equal(await photon({ orgId: "org_other", memberId: owner.id }), null);
  assert.equal(await photon({ memberId: owner.id }), null);
  assert.equal(
    (await resolveCaller({ authenticator: "local-dev", principalId: "local-dev" }))?.memberId,
    owner.id,
  );
  assert.equal(await resolveCaller({ authenticator: "unknown-app", principalId: "u1" }), null);
  assert.equal(await resolveCaller({ authenticator: "none", principalId: "anonymous" }), null);
});

withTestDb("saveItems upserts by name key and logs price changes", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const [a] = await saveItems(
    TEST_ORG,
    [{ name: "Windows, in and out", unitKind: "each", unitLabel: "window", priceCents: 1200 }],
    owner.id,
  );
  const [b] = await saveItems(
    TEST_ORG,
    [{ name: "windows in and out", unitKind: "each", unitLabel: "window", priceCents: 1300 }],
    owner.id,
  );
  assert.equal(a.id, b.id);
  assert.equal(b.priceCents, 1300);
  assert.equal(b.version, 2);
  assert.equal((await versions(TEST_ORG)).pricebookVersion, 2);
});

withTestDb("saveItemsWithOutcome says which items were added, updated, or already saved as is", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  await saveItems(TEST_ORG, [{ name: "Gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 300 }], owner.id);
  await saveItems(TEST_ORG, [{ name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.id);
  const sheet = Array.from({ length: 60 }, (_, i) => ({
    name: `Sample item ${i + 1}`,
    unitKind: "each" as const,
    unitLabel: "piece",
    priceCents: 100 + i,
  }));
  const saved = await saveItemsWithOutcome(
    TEST_ORG,
    [
      { name: "gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 200 },
      { name: "Widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 },
      ...sheet,
    ],
    owner.id,
  );
  assert.deepEqual(saved.slice(0, 3).map((s) => [s.item.name, s.outcome, s.item.priceCents]), [
    ["Gadget fitting", "updated", 200],
    ["Widget service", "unchanged", 1200],
    ["Sample item 1", "added", 100],
  ]);
  assert.equal(saved.filter((s) => s.outcome === "added").length, 60);
  assert.equal((await listItems(TEST_ORG)).length, 62);
});

withTestDb("rules save, suggest, and retire", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const r = await saveRule(
    TEST_ORG,
    {
      text: "add $50 for 3rd story or higher",
      kind: "pricing_modifier",
      effect: { op: "add_fixed", amount: 5000, appliesTo: "any" },
    },
    owner.id,
  );
  await saveRule(
    TEST_ORG,
    { text: "we don't do post-construction", kind: "exclusion", status: "suggested" },
    owner.id,
  );
  assert.equal((await listRules(TEST_ORG)).length, 1);
  assert.equal((await listRules(TEST_ORG, { includeSuggested: true })).length, 2);
  await retireRule(TEST_ORG, r.id, owner.id);
  assert.equal((await listRules(TEST_ORG)).length, 0);
});

withTestDb("customers search is accent-insensitive and adds properties", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const c = await saveCustomer(
    TEST_ORG,
    { name: "María López", phone: "305-555-0142", address: "4512 Palm Ave" },
    owner.id,
  );
  assert.equal((await searchCustomers(TEST_ORG, "maria lopez"))[0]?.id, c.id);
  assert.equal((await searchCustomers(TEST_ORG, "palm"))[0]?.properties[0]?.address, "4512 Palm Ave");
  assert.deepEqual(c.phones, ["+13055550142"]);
});

withTestDb("recordEvent is idempotent per key", async () => {
  assert.deepEqual(await recordEvent({ orgId: TEST_ORG, kind: "x", key: "k1" }), { inserted: true });
  assert.deepEqual(await recordEvent({ orgId: TEST_ORG, kind: "x", key: "k1" }), { inserted: false });
  assert.deepEqual(await recordEvent({ orgId: TEST_ORG, kind: "x" }), { inserted: true });
  assert.deepEqual(await recordEvent({ orgId: TEST_ORG, kind: "x" }), { inserted: true });
});

withTestDb("removeMember stops phones and keeps the last owner", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const crew = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member", addedByMemberId: owner.id });
  await addPhone(TEST_ORG, crew.id, "305-555-0143");
  await assert.rejects(removeMember(TEST_ORG, owner.id), /LAST_OWNER/);
  const removed = await removeMember(TEST_ORG, crew.id);
  assert.equal(removed.status, "removed");
  assert.equal((await findMemberByPhone("+13055550143"))?.phone.status, "stopped");
  assert.deepEqual((await listMembers(TEST_ORG)).map((m) => m.id), [owner.id]);
  assert.equal(
    await resolveCaller({ authenticator: "photon-imessage", principalId: "x", attributes: { memberId: crew.id } }),
    null,
  );
  const second = await createMember({ orgId: TEST_ORG, name: "Ana", role: "owner" });
  assert.equal((await removeMember(TEST_ORG, owner.id)).status, "removed");
  await assert.rejects(removeMember(TEST_ORG, second.id), /LAST_OWNER/);
});

withTestDb("reactivateMember brings a removed member back with a pending phone", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const admin = await createMember({ orgId: TEST_ORG, name: "Ana", role: "admin" });
  const crew = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member", addedByMemberId: owner.id });
  const phone = await addPhone(TEST_ORG, crew.id, "305-555-0143");
  await recordInbound(TEST_ORG, phone.id, "thread_1", new Date());
  await removeMember(TEST_ORG, crew.id);
  const back = await reactivateMember(TEST_ORG, crew.id, "+13055550143", {
    name: "Carlos Diaz",
    role: "admin",
    language: "es",
    addedByMemberId: admin.id,
  });
  assert.equal(back.id, crew.id);
  assert.equal(back.status, "active");
  assert.equal(back.name, "Carlos Diaz");
  assert.equal(back.role, "admin");
  assert.equal(back.language, "es");
  assert.equal(back.addedByMemberId, admin.id);
  assert.equal((await findMemberByPhone("+13055550143"))?.phone.status, "pending");
  await assert.rejects(reactivateMember(TEST_ORG, crew.id, "+13055550199", { name: "X", role: "member", addedByMemberId: owner.id }), /PHONE_NOT_FOUND/);
});

withTestDb("addPhone rejects another member's number and bad input", async () => {
  const a = await createMember({ orgId: TEST_ORG, name: "A", role: "owner" });
  const b = await createMember({ orgId: TEST_ORG, name: "B", role: "member" });
  const first = await addPhone(TEST_ORG, a.id, "3055550101");
  assert.equal((await addPhone(TEST_ORG, a.id, "+13055550101")).id, first.id);
  await assert.rejects(addPhone(TEST_ORG, b.id, "+13055550101"), /PHONE_IN_USE/);
  await assert.rejects(addPhone(TEST_ORG, b.id, "12"), /INVALID_PHONE/);
});

withTestDb("upsertThread makes one thread per member, reports creation once, and follows a new session", async () => {
  const m = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const first = await upsertThread(TEST_ORG, m.id, "s1");
  assert.equal(first.created, true);
  assert.equal(first.conversation.kind, "thread");
  const second = await upsertThread(TEST_ORG, m.id, "s2");
  assert.equal(second.created, false);
  assert.equal(second.conversation.id, first.conversation.id);
  assert.equal((await threadFor(TEST_ORG, m.id))?.eveSessionId, "s2");
  assert.equal((await memberConversationForSession(TEST_ORG, m.id, "s2"))?.id, first.conversation.id);
  assert.equal(await memberConversationForSession(TEST_ORG, m.id, "s1"), null);
  const other = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member" });
  assert.equal(await memberConversationForSession(TEST_ORG, other.id, "s2"), null);
  await assert.rejects(upsertThread("org_nope", m.id, "s3"), /MEMBER_NOT_FOUND/);
});

withTestDb("local-dev is refused in production", async () => {
  await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const saved = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    assert.equal(await resolveCaller({ authenticator: "local-dev", principalId: "local-dev" }), null);
  } finally {
    if (saved === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved;
  }
});

withTestDb("price changes are logged and unchanged saves do not bump the version", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const input = { name: "Widget service", unitKind: "each" as const, unitLabel: "widget", priceCents: 500 };
  const [item] = await saveItems(TEST_ORG, [input], owner.id);
  await saveItems(TEST_ORG, [input], owner.id);
  assert.equal((await versions(TEST_ORG)).pricebookVersion, 1);
  const renamed = await updateItem(TEST_ORG, item.id, { priceCents: 700, name: "Widget service (std)" }, owner.id, "msg1");
  assert.equal(renamed.version, 2);
  assert.equal((await versions(TEST_ORG)).pricebookVersion, 2);
  const changes = await db().select().from(pricebookChanges);
  assert.deepEqual(changes.map((c) => c.field).sort(), ["name", "price_cents"]);
  const price = changes.find((c) => c.field === "price_cents");
  assert.equal(price?.oldValue, "500");
  assert.equal(price?.newValue, "700");
  assert.equal(price?.sourceMessageId, "msg1");
  const [again] = await saveItems(TEST_ORG, [{ ...input, name: "widget service std" }], owner.id);
  assert.equal(again.id, item.id);
});

withTestDb("saveCustomer updates, dedupes contact details and addresses, and searches by phone", async () => {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const c = await saveCustomer(TEST_ORG, { name: "Pat Example", email: "Pat@Example.com" }, owner.id);
  const u = await saveCustomer(
    TEST_ORG,
    { customerId: c.id, phone: "(305) 555-0188", address: "9 Oak St", language: "es" },
    owner.id,
  );
  await saveCustomer(TEST_ORG, { customerId: c.id, phone: "305 555 0188", address: "9 oak st.", email: "pat@example.com" }, owner.id);
  const final = (await getCustomer(TEST_ORG, c.id))!;
  assert.equal(u.language, "es");
  assert.deepEqual(final.phones, ["+13055550188"]);
  assert.deepEqual(final.emails, ["pat@example.com"]);
  assert.equal(final.properties.length, 1);
  assert.equal((await searchCustomers(TEST_ORG, "555-0188"))[0]?.id, c.id);
  assert.equal((await searchCustomers(TEST_ORG, "PAT oak"))[0]?.id, c.id);
  assert.equal((await searchCustomers(TEST_ORG, "100%")).length, 0);
  await assert.rejects(saveCustomer(TEST_ORG, { phone: "305-555-0100" }, owner.id), /NAME_REQUIRED/);
  await assert.rejects(saveCustomer(TEST_ORG, { name: "X", phone: "12" }, owner.id), /INVALID_PHONE/);
});

withTestDb("recordInbound reports verified only for the call that moved the phone out of pending", async () => {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const ph = await addPhone(TEST_ORG, member.id, "+15555550199");
  const at = new Date("2026-10-16T12:00:00Z");
  const results = await Promise.all([recordInbound(TEST_ORG, ph.id, "t1", at), recordInbound(TEST_ORG, ph.id, "t1", at)]);
  assert.deepEqual(results.map((r) => r.verified).sort(), [false, true]);
  assert.deepEqual(await recordInbound(TEST_ORG, ph.id, "t2", at), { verified: false });
});
