// These test the real client; a PHOTON_ADMIN_FAKE in .env.local (for local provisioning) would skip it.
delete process.env.PHOTON_ADMIN_FAKE;

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPhotonAdmin } from "./photon-admin";

type Call = { url: string; method: string; headers: Headers; body: unknown };

function stub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    assert.ok(next, "unexpected extra request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchStub };
}

const options = (fetchStub: typeof fetch) => ({
  fetch: fetchStub,
  baseUrl: "https://photon.test",
  projectId: "proj_1",
  projectSecret: "sekret",
});
const user = { id: "u1", type: "shared", phoneNumber: "+15555550142", assignedPhoneNumber: "+15555550100" };

test("ensureSharedUser reuses an existing registration", async () => {
  const { calls, fetchStub } = stub([{ body: { succeed: true, data: { users: [user] } } }]);
  const result = await createPhotonAdmin(options(fetchStub)).ensureSharedUser({ e164: "+15555550142" });
  assert.deepEqual(result, { id: "u1", e164: "+15555550142", assignedLine: "+15555550100" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(
    calls[0].url,
    "https://photon.test/projects/proj_1/users/?type=shared&search=%2B15555550142&limit=50",
  );
  assert.equal(calls[0].headers.get("authorization"), `Basic ${Buffer.from("proj_1:sekret").toString("base64")}`);
});

test("ensureSharedUser ignores search hits for other numbers, then creates and returns the assigned line", async () => {
  const other = { ...user, id: "u0", phoneNumber: "+15555550999" };
  const { calls, fetchStub } = stub([
    { body: { succeed: true, data: { users: [other] } } },
    { body: { succeed: true, data: user } },
  ]);
  const result = await createPhotonAdmin(options(fetchStub)).ensureSharedUser({
    e164: "+15555550142",
    firstName: "Carlos",
  });
  assert.equal(result.assignedLine, "+15555550100");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, "https://photon.test/projects/proj_1/users/");
  assert.deepEqual(calls[1].body, { type: "shared", phoneNumber: "+15555550142", firstName: "Carlos" });
});

test("a 409 on create falls back to the search result", async () => {
  const { calls, fetchStub } = stub([
    { body: { succeed: true, data: { users: [] } } },
    { status: 409, body: { succeed: false, error: "conflict" } },
    { body: { succeed: true, data: { users: [user] } } },
  ]);
  const result = await createPhotonAdmin(options(fetchStub)).ensureSharedUser({ e164: "+15555550142" });
  assert.equal(result.id, "u1");
  assert.equal(calls.length, 3);
});

test("other failures surface as errors", async () => {
  const { fetchStub } = stub([
    { body: { succeed: true, data: { users: [] } } },
    { status: 500, body: { succeed: false } },
  ]);
  await assert.rejects(createPhotonAdmin(options(fetchStub)).ensureSharedUser({ e164: "+15555550142" }), /500/);
});

test("missing credentials throw before any request", async () => {
  const { calls, fetchStub } = stub([]);
  const saved = { id: process.env.IMESSAGE_PROJECT_ID, secret: process.env.IMESSAGE_PROJECT_SECRET };
  delete process.env.IMESSAGE_PROJECT_ID;
  delete process.env.IMESSAGE_PROJECT_SECRET;
  try {
    await assert.rejects(createPhotonAdmin({ fetch: fetchStub }).ensureSharedUser({ e164: "+15555550142" }), /credentials/i);
    assert.equal(calls.length, 0);
  } finally {
    if (saved.id !== undefined) process.env.IMESSAGE_PROJECT_ID = saved.id;
    if (saved.secret !== undefined) process.env.IMESSAGE_PROJECT_SECRET = saved.secret;
  }
});

test("PHOTON_ADMIN_FAKE=1 returns the fake shape without touching the network", async () => {
  const { calls, fetchStub } = stub([]);
  process.env.PHOTON_ADMIN_FAKE = "1";
  try {
    const result = await createPhotonAdmin({ fetch: fetchStub }).ensureSharedUser({ e164: "+15555550142" });
    assert.deepEqual(result, { id: "fake_+15555550142", e164: "+15555550142", assignedLine: "+15555550100" });
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.PHOTON_ADMIN_FAKE;
  }
});

test("removeSharedUser finds the number's registration and deletes it by id", async () => {
  const { calls, fetchStub } = stub([{ body: { succeed: true, data: { users: [{ ...user, phoneNumber: "+15555550199", id: "other" }, user] } } }, { body: { succeed: true, data: {} } }]);
  assert.equal(await createPhotonAdmin(options(fetchStub)).removeSharedUser("+15555550142"), true);
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].url, "https://photon.test/projects/proj_1/users/u1/");
});

test("removeSharedUser on a number with no registration, or one deleted meanwhile, is a no-op", async () => {
  let { calls, fetchStub } = stub([{ body: { succeed: true, data: { users: [] } } }]);
  assert.equal(await createPhotonAdmin(options(fetchStub)).removeSharedUser("+15555550142"), false);
  assert.equal(calls.length, 1);
  ({ calls, fetchStub } = stub([{ body: { succeed: true, data: { users: [user] } } }, { status: 404, body: {} }]));
  assert.equal(await createPhotonAdmin(options(fetchStub)).removeSharedUser("+15555550142"), false);
});

test("removeSharedUser surfaces a provider failure", async () => {
  const { fetchStub } = stub([{ body: { succeed: true, data: { users: [user] } } }, { status: 500, body: {} }]);
  await assert.rejects(createPhotonAdmin(options(fetchStub)).removeSharedUser("+15555550142"), /500/);
});
