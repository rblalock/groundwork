// Usage receipts and limits: what each model call records, and how a business's limits admit, hold,
// and free its turns, including a text held back in the inbound queue.
process.env.BLOB_FAKE = "1";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { generateText, streamText } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { Chat } from "chat";
import { and, eq } from "drizzle-orm";
import { deliveries, events, turnReservations, usageReceipts } from "../schema/schema";
import { upsertThread } from "./conversations";
import { db } from "./db";
import { processMember, recordDelivery } from "./deliveries";
import { addPhone, createMember, recordInbound } from "./members";
import { isCompactionPrompt, meteredModel, readUsage, type CallUsage } from "./metered-model";
import { estimateCostUsd, ratesFor } from "./model-pricing";
import { createOrganization } from "./organizations";
import { parseDelivery, photonDeliveryHandler, type PhotonRuntime, type PhotonWebhookPayload } from "./photon-inbound";
import { updateProfile } from "./profile";
import { TEST_ORG, withTestDb } from "./test-db";
import { channelOf, recordUsage, type TurnRef } from "./usage";
import {
  LEASE_MS,
  WINDOW_MS,
  admitTurn,
  defaultLimits,
  limitsFor,
  markTurnRunning,
  releaseTurn,
  setUsageLimits,
  settleTurn,
  usageNow,
} from "./usage-limits";
import { allBusinessesUsage, monthlyUsage } from "./usage-report";

const T0 = new Date("2026-10-18T15:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const usage = (over: Partial<CallUsage> = {}): CallUsage => ({
  kind: "step",
  inputTokens: 10_000,
  cachedInputTokens: 8_000,
  cacheWriteTokens: 0,
  outputTokens: 500,
  reasoningTokens: 200,
  responseId: `resp_${crypto.randomUUID()}`,
  responseModel: "muse-spark-1.3",
  ...over,
});

const v4Usage = { inputTokens: { total: 1_200, noCache: 200, cacheRead: 1_000, cacheWrite: 0 }, outputTokens: { total: 300, text: 100, reasoning: 200 } };

test("prices come from the table, an env override, or the default's rates for an unlisted deployment", () => {
  const before = process.env.MODEL_PRICES;
  try {
    delete process.env.MODEL_PRICES;
    assert.deepEqual(ratesFor("muse-spark-1.3"), { rates: { input: 1.25, cachedInput: 0.15, cacheWrite: 0.15, output: 4.25 }, source: "table" });
    assert.equal(ratesFor("my-deployment").source, "fallback");
    process.env.MODEL_PRICES = JSON.stringify({ "my-deployment": { input: 1, output: 4 } });
    const env = ratesFor("my-deployment");
    assert.equal(env.source, "env");
    assert.deepEqual(env.rates, { input: 1, cachedInput: 0.2, cacheWrite: 0.2, output: 4 });
    // 2,000 uncached at $1.25, 8,000 cached at $0.15, 500 out at $4.25, per million.
    assert.equal(estimateCostUsd({ inputTokens: 10_000, cachedInputTokens: 8_000, cacheWriteTokens: 0, outputTokens: 500 }, ratesFor("muse-spark-1.3").rates), 0.005825);
  } finally {
    if (before === undefined) delete process.env.MODEL_PRICES;
    else process.env.MODEL_PRICES = before;
  }
});

test("the metered model reports every call's usage, streamed or not, compaction summaries marked", async () => {
  assert.deepEqual(readUsage(v4Usage), { inputTokens: 1_200, cachedInputTokens: 1_000, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 200 });
  assert.deepEqual(readUsage({ inputTokens: 5, outputTokens: 7 }), { inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 7, reasoningTokens: null });
  const reported: CallUsage[] = [];
  const base = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "Hello" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: v4Usage,
      warnings: [],
      response: { id: "resp_gen", modelId: "muse-spark-1.3-2026" },
    },
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "resp_stream", modelId: "muse-spark-1.3-2026" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Hi" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: v4Usage },
      ]),
    }),
  });
  const model = meteredModel(base, async (u) => void reported.push(u));
  const generated = await generateText({ model, prompt: "hello" });
  assert.equal(generated.text, "Hello");
  const streamed = streamText({ model, system: "You are performing a CONTEXT CHECKPOINT COMPACTION. Summarize.", prompt: "transcript" });
  assert.equal(await streamed.text, "Hi");
  assert.deepEqual(
    reported.map((r) => [r.kind, r.responseId, r.responseModel, r.outputTokens, r.reasoningTokens]),
    [
      ["step", "resp_gen", "muse-spark-1.3-2026", 300, 200],
      ["compaction", "resp_stream", "muse-spark-1.3-2026", 300, 200],
    ],
  );
  assert.equal(isCompactionPrompt([{ role: "system", content: "Be helpful." }]), false);

  // A receipt that can't be written never fails the call.
  const failing = meteredModel(base, async () => {
    throw new Error("database down");
  });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    assert.equal((await generateText({ model: failing, prompt: "hello" })).text, "Hello");
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

async function member(name = "Pat Owner", orgId = TEST_ORG, role: "owner" | "member" = "owner") {
  return createMember({ orgId, name, role });
}

const textAuth = (orgId: string, memberId: string, reservationId?: string) => ({
  authenticator: "photon-imessage",
  principalId: `member:${memberId}`,
  attributes: { orgId, memberId, ...(reservationId ? { reservationId } : {}) },
});

withTestDb("each model call of a turn leaves one receipt with its business, member, conversation, turn, and channel", async () => {
  const owner = await member();
  const { conversation } = await upsertThread(TEST_ORG, owner.id, "ses_thread");
  const admitted = await admitTurn({ orgId: TEST_ORG, memberId: owner.id, channel: "text", key: "text:dlv_1", now: T0 });
  assert.ok(admitted.ok);
  const ref = (stepIndex: number): TurnRef => ({ auth: textAuth(TEST_ORG, owner.id, admitted.reservationId), eveSessionId: "ses_thread", turnId: "turn_1", stepIndex });
  // Two steps, then the first one replayed: still two receipts.
  const first = usage({ responseId: "resp_a" });
  assert.deepEqual(await recordUsage(ref(0), first, { now: at(1_000) }), { recorded: true });
  assert.deepEqual(await recordUsage(ref(1), usage({ responseId: "resp_b", outputTokens: 300, reasoningTokens: null }), { now: at(2_000) }), { recorded: true });
  assert.deepEqual(await recordUsage(ref(0), first, { now: at(3_000) }), { recorded: false });

  const rows = await db().select().from(usageReceipts).where(eq(usageReceipts.orgId, TEST_ORG));
  assert.equal(rows.length, 2);
  const row = rows.find((r) => r.stepIndex === 0)!;
  assert.equal(row.memberId, owner.id);
  assert.equal(row.conversationId, conversation.id);
  assert.equal(row.turnId, "turn_1");
  assert.equal(row.channel, "text");
  assert.equal(row.reservationId, admitted.reservationId);
  assert.equal(row.deployment, process.env.AZURE_DEPLOYMENT_NAME?.trim() || "muse-wonder-1.0");
  assert.deepEqual([row.inputTokens, row.cachedInputTokens, row.outputTokens, row.reasoningTokens], [10_000, 8_000, 500, 200]);
  assert.ok(row.estimatedCostUsd > 0);

  // The month's report: one turn, two calls, by channel and member.
  const report = await monthlyUsage(TEST_ORG, { timeZone: "America/New_York", now: at(5_000) });
  assert.equal(report.month, "2026-10");
  assert.equal(report.totals.turns, 1);
  assert.equal(report.totals.calls, 2);
  assert.equal(report.totals.outputTokens, 800);
  assert.equal(report.totals.reasoningTokens, 200);
  assert.deepEqual(report.byChannel.map((c) => [c.channel, c.turns]), [["text", 1]]);
  assert.deepEqual(report.byMember.map((m) => [m.name, m.calls]), [["Pat Owner", 2]]);
  assert.equal(report.byDay.length, 18);
  assert.equal(report.byDay.find((d) => d.day === "2026-10-18")?.calls, 2);

  // A call with no business is not recorded; channels read from the auth.
  const warned: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args);
  try {
    assert.deepEqual(await recordUsage({ auth: null, eveSessionId: "ses_x", turnId: null, stepIndex: null }, usage()), { recorded: false });
  } finally {
    console.warn = warn;
  }
  assert.equal(channelOf({ authenticator: "app-web", principalId: "u" }), "web");
  assert.equal(channelOf({ authenticator: "app-job", principalId: "u" }), "job");
  assert.equal(channelOf({ authenticator: "local-dev", principalId: "u" }), "local");
});

withTestDb("receipts and limits stay in their own business", async () => {
  const other = await createOrganization({ name: "Other Business", id: "org_other" });
  const a = await member("Pat Owner", TEST_ORG);
  const b = await member("Sam Owner", other.id);
  await recordUsage({ auth: textAuth(TEST_ORG, a.id), eveSessionId: "ses_a", turnId: "t", stepIndex: 0 }, usage({ outputTokens: 111 }), { now: T0 });
  await recordUsage({ auth: textAuth(other.id, b.id), eveSessionId: "ses_b", turnId: "t", stepIndex: 0 }, usage({ outputTokens: 222 }), { now: T0 });
  const reportA = await monthlyUsage(TEST_ORG, { timeZone: "UTC", now: T0 });
  assert.equal(reportA.totals.outputTokens, 111);
  assert.deepEqual(reportA.byMember.map((m) => m.memberId), [a.id]);

  // B at its turn limit doesn't hold back A.
  await setUsageLimits(other.id, { hourlyTurns: 1 }, "admin");
  assert.ok((await admitTurn({ orgId: other.id, channel: "web", key: "web:1", now: T0 })).ok);
  assert.equal((await admitTurn({ orgId: other.id, channel: "web", key: "web:2", now: T0 })).ok, false);
  assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", now: T0 })).ok);
  assert.equal((await limitsFor(TEST_ORG)).limits.hourlyTurns, defaultLimits().hourlyTurns);

  // The super admins' summary: every business, most expensive first.
  const all = await allBusinessesUsage({ since: at(-60_000), until: at(60_000) });
  assert.deepEqual(all.map((r) => [r.orgId, r.outputTokens, r.customLimits]), [
    [other.id, 222, true],
    [TEST_ORG, 111, false],
  ]);
});

withTestDb("the hourly turn limit holds back the next turn until the oldest leaves the window", async () => {
  await setUsageLimits(TEST_ORG, { hourlyTurns: 2 }, "admin");
  for (const [i, ms] of [[1, 0], [2, 10 * 60_000]] as const) {
    const ok = await admitTurn({ orgId: TEST_ORG, channel: "web", key: `web:${i}`, now: at(ms) });
    assert.ok(ok.ok);
    await settleTurn(TEST_ORG, ok.reservationId, at(ms + 1_000));
  }
  const held = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:3", now: at(20 * 60_000) });
  assert.equal(held.ok, false);
  assert.ok(!held.ok);
  assert.equal(held.reason, "hourly_turns");
  assert.equal(held.retryAt.getTime(), T0.getTime() + WINDOW_MS + 1_000, "when the first turn leaves the window");
  // The window moves on: an hour after the first, one fits again.
  assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:3", now: at(WINDOW_MS + 1_000) })).ok);
  assert.equal((await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:4", now: at(WINDOW_MS + 2_000) })).ok, false);

  // A reservation eve refused doesn't count.
  await setUsageLimits(TEST_ORG, { hourlyTurns: 1 }, "admin");
  const later = at(5 * WINDOW_MS);
  const refusedByEve = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:5", now: later });
  assert.ok(refusedByEve.ok);
  await releaseTurn(TEST_ORG, refusedByEve.reservationId, later);
  assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:6", now: later })).ok);
});

withTestDb("the concurrency cap holds turns back while others run, and a settled turn frees its slot", async () => {
  await setUsageLimits(TEST_ORG, { concurrentTurns: 2 }, "admin");
  const one = await admitTurn({ orgId: TEST_ORG, channel: "text", key: "text:1", now: T0 });
  const two = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", now: T0 });
  assert.ok(one.ok && two.ok);
  await markTurnRunning(TEST_ORG, one.reservationId, { eveSessionId: "ses_1", turnId: "turn_1" }, T0);
  const third = await admitTurn({ orgId: TEST_ORG, channel: "job", key: "job:1", now: at(1_000) });
  assert.ok(!third.ok);
  assert.equal(third.reason, "concurrent_turns");
  assert.equal(third.retryAt.getTime(), at(31_000).getTime());
  // The same key is the same turn: a retried hand-off isn't a second one.
  const again = await admitTurn({ orgId: TEST_ORG, channel: "text", key: "text:1", now: at(2_000) });
  assert.deepEqual(again, { ok: true, reservationId: one.reservationId, duplicate: true });

  await settleTurn(TEST_ORG, one.reservationId, at(3_000));
  assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "job", key: "job:1", now: at(4_000) })).ok);
  const [row] = await db().select().from(turnReservations).where(eq(turnReservations.id, one.reservationId));
  assert.equal(row.status, "settled");
  assert.equal(row.turnId, "turn_1");
});

withTestDb("a reservation nobody hears from for 15 minutes is released; a model call keeps it alive", async () => {
  await setUsageLimits(TEST_ORG, { concurrentTurns: 1 }, "admin");
  const owner = await member();
  const stuck = await admitTurn({ orgId: TEST_ORG, memberId: owner.id, channel: "text", key: "text:stuck", now: T0 });
  assert.ok(stuck.ok);
  await markTurnRunning(TEST_ORG, stuck.reservationId, { eveSessionId: "ses_1", turnId: "turn_1" }, T0);
  // A model call ten minutes in renews the lease.
  await recordUsage({ auth: textAuth(TEST_ORG, owner.id, stuck.reservationId), eveSessionId: "ses_1", turnId: "turn_1", stepIndex: 0 }, usage(), { now: at(10 * 60_000) });
  assert.equal((await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", now: at(LEASE_MS + 60_000) })).ok, false);
  // Then silence: 15 minutes after the call, the slot is free.
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", now: at(10 * 60_000 + LEASE_MS + 1_000) })).ok);
  } finally {
    console.warn = warn;
  }
  const [row] = await db().select().from(turnReservations).where(eq(turnReservations.id, stuck.reservationId));
  assert.equal(row.status, "expired");
  // It still counts as a turn this hour.
  assert.equal((await usageNow(TEST_ORG, at(10 * 60_000 + LEASE_MS + 2_000))).window.turns, 2);
});

withTestDb("the hourly output-token limit counts measured tokens and what running turns still hold", async () => {
  await setUsageLimits(TEST_ORG, { hourlyOutputTokens: 20_000 }, "admin");
  const owner = await member();
  // 9,000 measured an hour ago's start, then a running turn holding 8,000.
  await recordUsage({ auth: textAuth(TEST_ORG, owner.id), eveSessionId: "ses_old", turnId: "t0", stepIndex: 0 }, usage({ outputTokens: 9_000 }), { now: T0 });
  const running = await admitTurn({ orgId: TEST_ORG, channel: "text", key: "text:1", now: at(1_000) });
  assert.ok(running.ok);
  const snapshot = await usageNow(TEST_ORG, at(2_000));
  assert.deepEqual([snapshot.window.measuredOutputTokens, snapshot.window.heldOutputTokens], [9_000, 8_000]);
  const held = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", now: at(2_000) });
  assert.ok(!held.ok);
  assert.equal(held.reason, "hourly_output_tokens");
  assert.equal(held.retryAt.getTime(), T0.getTime() + WINDOW_MS + 1_000, "when the 9,000 leave the window");
  // The running turn measures 1,000 and settles: its hold is gone, and a turn fits again.
  await recordUsage({ auth: textAuth(TEST_ORG, owner.id, running.reservationId), eveSessionId: "ses_1", turnId: "t1", stepIndex: 0 }, usage({ outputTokens: 1_000 }), { now: at(3_000) });
  assert.equal((await usageNow(TEST_ORG, at(3_500))).window.outputTokens, 17_000);
  await settleTurn(TEST_ORG, running.reservationId, at(4_000));
  assert.ok((await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", now: at(5_000) })).ok);
});

withTestDb("an older reservation eve folded into a later turn of the same session is merged", async () => {
  const first = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", eveSessionId: "ses_1", now: T0 });
  const second = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:2", eveSessionId: "ses_1", now: at(1_000) });
  assert.ok(first.ok && second.ok);
  await markTurnRunning(TEST_ORG, second.reservationId, { eveSessionId: "ses_1", turnId: "turn_1" }, at(2_000));
  const statuses = await db().select({ id: turnReservations.id, status: turnReservations.status }).from(turnReservations).where(eq(turnReservations.orgId, TEST_ORG));
  assert.deepEqual(new Map(statuses.map((s) => [s.id, s.status])), new Map([[first.reservationId, "merged"], [second.reservationId, "running"]]));
  const window = (await usageNow(TEST_ORG, at(3_000))).window;
  assert.deepEqual([window.turns, window.active], [1, 1]);
});

withTestDb("limits are validated; null puts one back to the default", async () => {
  await assert.rejects(setUsageLimits(TEST_ORG, { hourlyTurns: 0 }, "admin"), /INVALID_LIMIT/);
  await assert.rejects(setUsageLimits(TEST_ORG, { concurrentTurns: 51 }, "admin"), /INVALID_LIMIT/);
  await assert.rejects(setUsageLimits(TEST_ORG, { hourlyOutputTokens: 1.5 }, "admin"), /INVALID_LIMIT/);
  assert.deepEqual(await setUsageLimits(TEST_ORG, { hourlyTurns: 5, concurrentTurns: 1 }, "admin"), { hourlyTurns: 5, hourlyOutputTokens: null, concurrentTurns: 1 });
  assert.deepEqual(await setUsageLimits(TEST_ORG, { hourlyTurns: null }, "admin"), { hourlyTurns: null, hourlyOutputTokens: null, concurrentTurns: 1 });
  assert.equal((await limitsFor(TEST_ORG)).limits.hourlyTurns, defaultLimits().hourlyTurns);
});

// ---------------------------------------------------------------------------------------------
// A text over the limits waits in the inbound queue

const SECRET = "test-webhook-secret";
const OWNER = "+13055550100";
const LINE = "+15555550100";
const adapter = createiMessageAdapter({ clients: { address: "127.0.0.1:9", phone: "shared", token: "fake" }, webhookSecret: SECRET });
const chat = new Chat({ adapters: { imessage: adapter }, state: createMemoryState(), userName: "Assistant" });
const threadOf = (from: string) => adapter.encodeThreadId({ chatGuid: `iMessage;-;${from}`, phone: LINE });

function textPayload(id: string, text: string, sent: Date): PhotonWebhookPayload {
  return {
    event: "messages",
    message: { id, direction: "inbound", timestamp: sent.toISOString(), sender: { id: OWNER }, content: { type: "text", text } as { type: string } },
    space: { id: `iMessage;-;${OWNER}`, phone: LINE },
  };
}

withTestDb("a text over the limits stays queued, the member hears it once, and it's answered when the limit frees up", async () => {
  await updateProfile(TEST_ORG, { name: "Acme Widgets" }, "system");
  const owner = await member("Pat Example");
  const phone = await addPhone(TEST_ORG, owner.id, OWNER);
  await recordInbound(TEST_ORG, phone.id, threadOf(OWNER), at(-60_000));
  await setUsageLimits(TEST_ORG, { hourlyTurns: 1 }, "admin");
  // Someone's web turn used this hour's only turn.
  const web = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1", now: at(-5 * 60_000) });
  assert.ok(web.ok);
  await settleTurn(TEST_ORG, web.reservationId, at(-4 * 60_000));

  const sends: Array<{ text: unknown; reservationId: unknown }> = [];
  const posts: string[] = [];
  let clock = T0;
  const runtime: PhotonRuntime = {
    async send(_thread, content, options) {
      sends.push({ text: content, reservationId: options.auth.attributes.reservationId });
    },
    async post(_threadId, text) {
      posts.push(text);
      return [`out_${posts.length}`];
    },
    markRead: async () => {},
    parse: (payload) => parseDelivery(payload, { parseMessage: (raw) => adapter.parseMessage(raw), thread: (id) => chat.thread(id) }),
    clock: () => clock,
    sleep: async (ms) => void (clock = new Date(clock.getTime() + ms)),
  };
  const handler = photonDeliveryHandler(runtime);
  for (const [id, text, ms] of [["pm_1", "quote 100 Example St", 0], ["pm_2", "and the garage", 1_000]] as const) {
    await recordDelivery({ orgId: TEST_ORG, memberId: owner.id, providerMessageId: id, kind: "message", threadId: threadOf(OWNER), payload: textPayload(id, text, at(ms)) as never, sentAt: at(ms), now: at(ms) });
  }

  assert.equal(await processMember(TEST_ORG, owner.id, handler, { clock: () => clock }), 1);
  assert.equal(sends.length, 0, "nothing reached eve");
  assert.equal(posts.length, 1);
  assert.match(posts[0], /Acme Widgets hit its assistant usage limit for this hour/);
  const [held, behind] = await db().select().from(deliveries).where(eq(deliveries.orgId, TEST_ORG)).orderBy(deliveries.sentAt);
  assert.equal(held.status, "pending");
  assert.equal(held.attempts, 0, "a hold isn't a failed try");
  assert.equal(held.outcome, "usage_limit");
  assert.equal(held.progress.held, true);
  assert.equal(held.nextAttemptAt.getTime(), at(-5 * 60_000 + WINDOW_MS + 1_000).getTime());
  assert.equal(behind.status, "pending", "the next text waits behind it");

  // Still over at the next try (a second turn came in on the web): no second line within the hour.
  clock = held.nextAttemptAt;
  const another = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:2", now: clock });
  assert.ok(another.ok);
  await settleTurn(TEST_ORG, another.reservationId, clock);
  assert.equal(await processMember(TEST_ORG, owner.id, handler, { clock: () => clock }), 1);
  assert.equal(sends.length, 0);
  assert.equal(posts.length, 1);
  assert.equal((await db().select().from(events).where(and(eq(events.orgId, TEST_ORG), eq(events.kind, "usage.notice")))).length, 1);

  // The limit frees up: both texts go to eve, in order, each on its own reservation, and the first
  // isn't taken for a duplicate of its own claimed row.
  await setUsageLimits(TEST_ORG, { hourlyTurns: 10 }, "admin");
  const [again] = await db().select().from(deliveries).where(eq(deliveries.providerMessageId, "pm_1"));
  clock = again.nextAttemptAt;
  // The previous text's turn isn't in eve's events, so each hand-off waits out its turn first.
  await processMember(TEST_ORG, owner.id, handler, { clock: () => clock });
  assert.deepEqual(sends.map((s) => s.text), ["quote 100 Example St", "and the garage"]);
  assert.ok(sends.every((s) => typeof s.reservationId === "string"));
  assert.notEqual(sends[0].reservationId, sends[1].reservationId);
  const done = await db().select().from(deliveries).where(eq(deliveries.orgId, TEST_ORG));
  assert.deepEqual(done.map((d) => d.outcome).sort(), ["dispatch", "dispatch"]);
  assert.equal(posts.length, 1);
});

withTestDb("the usage hook marks an admitted turn running when eve starts it and settles it when it ends", async () => {
  const { default: hook } = await import("../agents/assistant/agent/hooks/usage");
  const events = hook.events as Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
  const admitted = await admitTurn({ orgId: TEST_ORG, channel: "web", key: "web:1" });
  assert.ok(admitted.ok);
  const ctx = { session: { id: "ses_1", auth: { current: { authenticator: "app-web", principalId: "u", attributes: { orgId: TEST_ORG, reservationId: admitted.reservationId } } } } };
  const status = async () => (await db().select().from(turnReservations).where(eq(turnReservations.id, admitted.reservationId)))[0];
  await events["turn.started"]({ type: "turn.started", data: { turnId: "turn_7", sequence: 1 } }, ctx);
  assert.deepEqual([(await status()).status, (await status()).turnId, (await status()).eveSessionId], ["running", "turn_7", "ses_1"]);
  await events["turn.failed"]({ type: "turn.failed", data: {} }, ctx);
  assert.equal((await status()).status, "settled");
  // A turn with no reservation (local dev, evals) is left alone.
  await events["turn.started"]({ type: "turn.started", data: { turnId: "turn_8", sequence: 2 } }, { session: { id: "ses_2", auth: { current: { authenticator: "local-dev", principalId: "dev" } } } });
});
