// A super admin's fixes to one business: rename it, move its owner to a new phone, remove its inbox.
import { installTransport, signIn, superAdminViewing, call, refused, person, otherBusiness, appCaller } from "./pages/test-support";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { loginCodes } from "../schema/schema";
import { PATCH as renameRoute } from "../app/api/admin/businesses/[id]/route";
import { DELETE as removeInboxRoute, POST as makeInboxRoute } from "../app/api/admin/businesses/[id]/inbox/route";
import { POST as phoneRoute } from "../app/api/admin/businesses/[id]/phone/route";
import { agentMailGateway, setAgentMailGatewayForTests } from "../core/agentmail";
import { changeMemberPhone } from "../core/business-admin";
import { db } from "../core/db";
import { requireViewer } from "./guards";
import { findMemberByPhone } from "../core/members";
import { getOrganization } from "../core/organizations";
import { getProfile } from "../core/profile";
import { TEST_ORG, withTestDb } from "../core/test-db";

const OWNER = "+15555550101";
const NEW_PHONE = "+15555550109";

withTestDb("a super admin renames a business: its name everywhere, and a free slug", async () => {
  installTransport();
  await person("Pat Owner", "owner", OWNER);
  const owner = await signIn(OWNER);
  const admin = await superAdminViewing(TEST_ORG);
  await otherBusiness();

  refused(await call(renameRoute, owner, { method: "PATCH", params: { id: TEST_ORG }, body: { name: "Mine", slug: "mine" } }), 403, "NOT_SUPER_ADMIN");
  refused(await call(renameRoute, admin, { method: "PATCH", params: { id: TEST_ORG }, body: { name: "Example Co", slug: "other-co" } }), 409, "SLUG_TAKEN");
  refused(await call(renameRoute, admin, { method: "PATCH", params: { id: TEST_ORG }, body: { name: "Example Co", slug: "Example Co" } }), 400, "INVALID_SLUG");
  refused(await call(renameRoute, admin, { method: "PATCH", params: { id: TEST_ORG }, body: { name: "  ", slug: "example-co" } }), 400, "INVALID_NAME");

  const renamed = await call(renameRoute, admin, { method: "PATCH", params: { id: TEST_ORG }, body: { name: "  Example   Co ", slug: "example-co" } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const org = await getOrganization(TEST_ORG);
  assert.equal(org?.name, "Example Co");
  assert.equal(org?.slug, "example-co");
  assert.equal((await getProfile(TEST_ORG)).name, "Example Co", "the profile, PDFs, and pages follow");
  refused(await call(renameRoute, admin, { method: "PATCH", params: { id: "org_nope" }, body: { name: "X", slug: "x" } }), 404, "NO_SUCH_BUSINESS");
});

withTestDb("a super admin moves the owner to a new phone: registered, pending, and the old number released", async () => {
  installTransport();
  const pat = await person("Pat Owner", "owner", OWNER);
  await person("Sam Crew", "member", "+15555550102");
  const admin = await superAdminViewing(TEST_ORG);
  const owner = await signIn(OWNER);
  assert.equal((await appCaller(owner)).memberId, pat.memberId, "signed in on the old phone");

  refused(await call(phoneRoute, owner, { params: { id: TEST_ORG }, body: { memberId: pat.memberId, from: OWNER, to: NEW_PHONE } }), 403, "NOT_SUPER_ADMIN");
  refused(await call(phoneRoute, admin, { params: { id: TEST_ORG }, body: { memberId: pat.memberId, from: OWNER, to: "+15555550102" } }), 409, "PHONE_IN_USE");
  refused(await call(phoneRoute, admin, { params: { id: TEST_ORG }, body: { memberId: pat.memberId, from: OWNER, to: "12" } }), 400, "INVALID_PHONE");
  refused(await call(phoneRoute, admin, { params: { id: TEST_ORG }, body: { memberId: pat.memberId, from: "+15555550102", to: NEW_PHONE } }), 404, "PHONE_NOT_FOUND");

  const registered: string[] = [];
  const released: string[] = [];
  const moved = await changeMemberPhone(
    TEST_ORG,
    { memberId: pat.memberId, from: OWNER, to: "(555) 555-0109" },
    {
      photon: {
        ensureSharedUser: async ({ e164 }) => (registered.push(e164), { id: `pu_${e164}`, e164, assignedLine: "+15555550100" }),
        removeSharedUser: async (e164) => (released.push(e164), true),
      },
    },
  );
  assert.deepEqual(moved, { e164: NEW_PHONE, assignedLine: "+15555550100" });
  assert.deepEqual(registered, [NEW_PHONE]);
  assert.deepEqual(released, [OWNER]);
  const found = await findMemberByPhone(NEW_PHONE);
  assert.equal(found?.member.id, pat.memberId);
  assert.equal(found?.phone.status, "pending", "their first text from it activates it");
  assert.equal(found?.phone.assignedLine, "+15555550100");
  assert.equal(await findMemberByPhone(OWNER), null, "the old number reaches no one");
  await assert.rejects(appCaller(owner), "the session on the old phone is signed out");
  const outstanding = await db().select().from(loginCodes).where(and(eq(loginCodes.phoneE164, OWNER), isNull(loginCodes.consumedAt)));
  assert.equal(outstanding.length, 0, "no sign-in code for the old number still works");
  assert.ok(await requireViewer(admin), "other people's sessions are untouched");
});

withTestDb("a super admin removes a business's inbox, and a new one is asked for under a new client id", async () => {
  installTransport();
  const admin = await superAdminViewing(TEST_ORG);
  const made: string[] = [];
  const deleted: string[] = [];
  setAgentMailGatewayForTests({
    ...agentMailGateway(),
    createInbox: async ({ clientId }) => (made.push(clientId), { inboxId: `inbox_${made.length}`, address: `test-business-${made.length}@agentmail.example` }),
    deleteInbox: async (inboxId) => void deleted.push(inboxId),
  });
  try {
    assert.equal((await call(makeInboxRoute, admin, { params: { id: TEST_ORG } })).status, 201);
    const removed = await call(removeInboxRoute, admin, { method: "DELETE", params: { id: TEST_ORG } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(deleted, ["inbox_1"]);
    const org = await getOrganization(TEST_ORG);
    assert.equal(org?.inboxId, null);
    assert.equal(org?.inboxAddress, null);
    // Removing again changes nothing; making another doesn't get the deleted one back.
    assert.equal((await call(removeInboxRoute, admin, { method: "DELETE", params: { id: TEST_ORG } })).status, 200);
    assert.deepEqual(deleted, ["inbox_1"]);
    assert.equal((await call(makeInboxRoute, admin, { params: { id: TEST_ORG } })).status, 201);
    assert.deepEqual(made, [`gw-business-${TEST_ORG}`, `gw-business-${TEST_ORG}-2`]);
    assert.equal((await getOrganization(TEST_ORG))?.inboxAddress, "test-business-2@agentmail.example");
  } finally {
    setAgentMailGatewayForTests(null);
  }
});
