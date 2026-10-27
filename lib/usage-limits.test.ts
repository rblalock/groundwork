// The usage limits at the web and job entry points (eve's channel auth), and the super admins' route
// that edits them. The text entry point is in core/usage.test.ts.
import { installTransport, signIn, superAdminViewing, call, refused, person } from "./pages/test-support";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { conversations, members, turnReservations } from "../schema/schema";
import { PATCH as usageLimitsRoute } from "../app/api/admin/businesses/[id]/usage-limits/route";
import { upsertThread } from "../core/conversations";
import { db } from "../core/db";
import { jobToken } from "../core/job-token";
import { eveJobRunner, getOwnJob, openJob, runJobTurn, setJobRunnerForTests } from "../core/jobs";
import { TEST_ORG, withTestDb } from "../core/test-db";
import { admitTurn, limitsFor, setUsageLimits } from "../core/usage-limits";
import { UsageLimitedError, appWebAuth, jobRuntimeAuth, withUsageAdmission } from "./eve-auth";

const OWNER = "+15555550101";

const eveRequest = (path: string, init: { cookie?: string; bearer?: string; method?: string; body?: string } = {}) =>
  new Request(`http://localhost:3000/eve/v1${path}`, {
    method: init.method ?? "POST",
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}) },
    body: init.body,
  });

async function fillTurns(n: number) {
  for (let i = 0; i < n; i++) assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "text", key: `text:fill_${i}` })).ok);
}

withTestDb("a web turn over the limits is refused with a 429 in the member's language; under them it carries its reservation", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", OWNER);
  const headers = await signIn(OWNER);
  const cookie = headers.get("cookie")!;
  await upsertThread(TEST_ORG, owner.memberId, "ses_thread");

  const auth = await appWebAuth()(eveRequest("/session/ses_thread", { cookie }));
  const reservationId = auth?.attributes.reservationId;
  assert.equal(typeof reservationId, "string");
  const [row] = await db().select().from(turnReservations).where(eq(turnReservations.id, reservationId as string));
  assert.deepEqual([row.channel, row.memberId, row.eveSessionId, row.status], ["web", owner.memberId, "ses_thread", "reserved"]);
  // Reading the stream starts no turn.
  const stream = await appWebAuth()(eveRequest("/session/ses_thread/stream", { cookie, method: "GET" }));
  assert.equal(stream?.attributes.reservationId, undefined);

  await setUsageLimits(TEST_ORG, { hourlyTurns: 1 }, "admin");
  const refusal = await Promise.resolve(appWebAuth()(eveRequest("/session/ses_thread", { cookie }))).then(
    () => assert.fail("admitted over the limit"),
    (error: unknown) => error,
  );
  assert.ok(refusal instanceof UsageLimitedError);
  assert.equal(refusal.response.status, 429);
  assert.ok(Number(refusal.response.headers.get("retry-after")) > 0);
  const body = (await refusal.response.json()) as { code: string; error: string; reason: string };
  assert.equal(body.code, "USAGE_LIMIT");
  assert.equal(body.reason, "hourly_turns");
  assert.match(body.error, /hit its assistant usage limit for this hour/);

  await db().update(members).set({ language: "es" }).where(eq(members.id, owner.memberId));
  const spanish = await Promise.resolve(appWebAuth()(eveRequest("/session/ses_thread", { cookie }))).catch((error: UsageLimitedError) => error.response.json());
  assert.match((spanish as { error: string }).error, /límite de uso del asistente/);
});

withTestDb("a turn eve refuses gives its reservation back", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", OWNER);
  const cookie = (await signIn(OWNER)).get("cookie")!;
  await upsertThread(TEST_ORG, owner.memberId, "ses_thread");
  let status = 400;
  const channel = withUsageAdmission({
    routes: [
      {
        method: "POST",
        path: "/eve/v1/session/:sessionId",
        handler: async (request: Request) => {
          await appWebAuth()(request);
          return new Response(null, { status });
        },
      },
    ],
  });
  const route = channel.routes[0] as { handler: (request: Request) => Promise<Response> };
  assert.equal((await route.handler(eveRequest("/session/ses_thread", { cookie }))).status, 400);
  status = 202;
  assert.equal((await route.handler(eveRequest("/session/ses_thread", { cookie }))).status, 202);
  const rows = await db().select({ status: turnReservations.status }).from(turnReservations).where(eq(turnReservations.orgId, TEST_ORG)).orderBy(turnReservations.createdAt);
  assert.deepEqual(rows.map((r) => r.status), ["released", "reserved"]);
});

withTestDb("a job turn over the limits is refused, and the job stays open rather than failed", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", OWNER);
  const { conversation: thread } = await upsertThread(TEST_ORG, owner.memberId, "ses_thread");
  const job = await openJob(owner, { id: "job_1", thread, title: "100 Example St" });
  const token = jobToken({ orgId: TEST_ORG, memberId: owner.memberId, conversationId: job.id });

  // Creating the job's session without a message starts no turn, even at the limit.
  await setUsageLimits(TEST_ORG, { hourlyTurns: 1 }, "admin");
  await fillTurns(1);
  assert.ok(await jobRuntimeAuth()(eveRequest("/session", { bearer: token })));
  await assert.rejects(
    async () => jobRuntimeAuth()(eveRequest("/session", { bearer: token, body: JSON.stringify({ message: "hi" }) })),
    (error: unknown) => error instanceof UsageLimitedError && error.response.status === 429,
  );
  await db().update(conversations).set({ eveSessionId: "ses_job" }).where(and(eq(conversations.orgId, TEST_ORG), eq(conversations.id, job.id)));
  await assert.rejects(
    async () => jobRuntimeAuth()(eveRequest("/session/ses_job", { bearer: token })),
    (error: unknown) => error instanceof UsageLimitedError && error.response.status === 429,
  );
  await setUsageLimits(TEST_ORG, { hourlyTurns: 10 }, "admin");
  const admitted = await jobRuntimeAuth()(eveRequest("/session/ses_job", { bearer: token }));
  assert.equal(typeof admitted?.attributes.reservationId, "string");

  // The runner turns eve's 429 into `limited`.
  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    response.end(JSON.stringify({ error: "limited", code: "USAGE_LIMIT" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const before = process.env.AGENT_URL;
  process.env.AGENT_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const outcome = await eveJobRunner.send({ orgId: TEST_ORG, memberId: owner.memberId, conversationId: job.id }, "ses_job", "hello", { signal: AbortSignal.timeout(5_000) });
    assert.deepEqual(outcome, { status: "limited", reply: null });
  } finally {
    if (before === undefined) delete process.env.AGENT_URL;
    else process.env.AGENT_URL = before;
    server.close();
  }

  // A held-back job turn leaves the job active, not failed.
  setJobRunnerForTests({ createSession: async () => "ses_job", send: async () => ({ status: "limited", reply: null }) });
  try {
    const result = await runJobTurn(owner, job.id, "add the garage", { operationId: "op_1" });
    assert.equal(result.status, "limited");
    assert.equal((await getOwnJob(TEST_ORG, owner.memberId, job.id))?.status, "active");
  } finally {
    setJobRunnerForTests(null);
  }
});

withTestDb("only a super admin can change a business's limits", async () => {
  installTransport();
  await person("Pat Owner", "owner", OWNER);
  const member = await signIn(OWNER);
  const admin = await superAdminViewing(TEST_ORG);
  const params = { id: TEST_ORG };

  refused(await call(usageLimitsRoute, member, { method: "PATCH", params, body: { hourlyTurns: 500 } }), 403, "NOT_SUPER_ADMIN");
  assert.equal((await limitsFor(TEST_ORG)).overrides.hourlyTurns, null);

  const saved = await call(usageLimitsRoute, admin, { method: "PATCH", params, body: { hourlyTurns: 500, concurrentTurns: 5 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body?.overrides, { hourlyTurns: 500, hourlyOutputTokens: null, concurrentTurns: 5 });
  assert.equal((await limitsFor(TEST_ORG)).limits.hourlyTurns, 500);

  refused(await call(usageLimitsRoute, admin, { method: "PATCH", params, body: { hourlyTurns: 0 } }), 400, "INVALID_LIMIT");
  refused(await call(usageLimitsRoute, admin, { method: "PATCH", params, body: { hourlyTurns: "lots" } }), 400, "INVALID_INPUT");
  refused(await call(usageLimitsRoute, admin, { method: "PATCH", params, body: { bypass: true } }), 400, "INVALID_INPUT");
  refused(await call(usageLimitsRoute, admin, { method: "PATCH", params: { id: "org_nope" }, body: { hourlyTurns: 5 } }), 404, "NO_SUCH_BUSINESS");

  const reset = await call(usageLimitsRoute, admin, { method: "PATCH", params, body: { hourlyTurns: null } });
  assert.deepEqual(reset.body?.overrides, { hourlyTurns: null, hourlyOutputTokens: null, concurrentTurns: 5 });
});
