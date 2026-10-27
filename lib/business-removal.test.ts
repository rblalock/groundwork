// The admin route that deletes a business: super admins only, and only with its name typed exactly.
import { installTransport, signIn, superAdminViewing, call, refused, appCaller, person } from "./pages/test-support";
import assert from "node:assert/strict";
import { DELETE as deleteRoute, GET as footprintRoute } from "../app/api/admin/businesses/[id]/route";
import { getOrganization } from "../core/organizations";
import { TEST_ORG, withTestDb } from "../core/test-db";
import { requireViewer } from "./guards";

const OWNER = "+15555550101";

withTestDb("a super admin reads what deleting a business removes, then deletes it by typing its name", async () => {
  process.env.BLOB_FAKE = "1";
  installTransport();
  await person("Pat Owner", "owner", OWNER);
  const owner = await signIn(OWNER);
  const admin = await superAdminViewing(TEST_ORG);

  refused(await call(footprintRoute, owner, { params: { id: TEST_ORG } }), 403, "NOT_SUPER_ADMIN");
  refused(await call(deleteRoute, owner, { method: "DELETE", params: { id: TEST_ORG }, body: { confirmName: "Test Business" } }), 403, "NOT_SUPER_ADMIN");

  const read = await call(footprintRoute, admin, { params: { id: TEST_ORG } });
  assert.equal(read.status, 200);
  const business = read.body?.business as { name: string; members: number; phones: string[]; signIns: number };
  assert.equal(business.name, "Test Business");
  assert.equal(business.members, 1);
  assert.deepEqual(business.phones, [OWNER]);
  assert.equal(business.signIns, 1);

  refused(await call(deleteRoute, admin, { method: "DELETE", params: { id: TEST_ORG }, body: { confirmName: "Test" } }), 400, "NAME_MISMATCH");
  assert.ok(await getOrganization(TEST_ORG), "a near miss deletes nothing");

  const deleted = await call(deleteRoute, admin, { method: "DELETE", params: { id: TEST_ORG }, body: { confirmName: "Test Business" } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(await getOrganization(TEST_ORG), null);
  refused(await call(footprintRoute, admin, { params: { id: TEST_ORG } }), 404, "NO_SUCH_BUSINESS");

  // The owner's sign-in went with it; the super admin is still signed in, with no business open.
  await assert.rejects(appCaller(owner));
  assert.equal((await requireViewer(admin)).superAdmin, true);
});
