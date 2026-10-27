import assert from "node:assert/strict";
import { test } from "node:test";
import { asc, eq } from "drizzle-orm";
import { conversationEvents, conversations, organization } from "../schema/schema";
import { memberAuth } from "./channel-dispatch";
import {
  activityFor,
  activitySummary,
  deliveryReachedEve,
  persistEvent,
  pruneConversationEvents,
  redactInput,
  threadTurnRunning,
  type StreamEvent,
} from "./conversation-events";
import { upsertThread } from "./conversations";
import { db } from "./db";
import { APP_WEB, addPhone, createMember } from "./members";
import { TEST_ORG, withTestDb } from "./test-db";

let n = 0;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 18, 15, 0, 0) + ms).toISOString();
function ev(type: string, data: Record<string, unknown>, ms?: number): StreamEvent {
  n += 1;
  return { type, data, meta: { id: `evt_${String(n).padStart(4, "0")}_${type}`, at: at(ms ?? n * 1000) } };
}

async function member(orgId = TEST_ORG, phone = "+13055550100") {
  const m = await createMember({ orgId, name: "Pat Example", role: "owner" });
  const p = await addPhone(orgId, m.id, phone);
  return { member: m, phone: p };
}

const rows = () => db().select().from(conversationEvents).orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));

test("redactInput keeps the shape and short values, never secrets, codes, phones, or emails", () => {
  const long = "x".repeat(200);
  assert.deepEqual(
    redactInput({
      title: "100 Example St",
      note: long,
      phone: "+13055550100",
      email: "jane@example.test",
      apiKey: "sk_live_123",
      code: "123456",
      lines: [{ name: "Widget", quantity: 2, priceCents: 500 }, 2, 3, 4, 5],
      nested: { deeper: { deepest: { x: 1 } } },
    }),
    {
      title: "100 Example St",
      note: `${"x".repeat(59)}…`,
      phone: "[redacted]",
      email: "[redacted]",
      apiKey: "[redacted]",
      code: "[redacted]",
      lines: ["{…}", 2, 3, "…2 more"],
      nested: { deeper: "{…}" },
    },
  );
});

withTestDb("a text's turn is recorded under the member's thread: messages, tools with duration, and how it ended", async () => {
  const { member: m, phone } = await member();
  const { conversation: thread } = await upsertThread(TEST_ORG, m.id, "ses_a");
  const auth = { ...memberAuth(m, phone), attributes: { ...memberAuth(m, phone).attributes, deliveryId: "dlv_1" } };
  const session = { id: "ses_a", auth };
  const events = [
    ev("turn.started", { turnId: "t1", sequence: 1 }, 0),
    ev("message.received", { turnId: "t1", message: "quote 100 Example St", parts: [{ type: "text" }, { type: "file" }] }, 100),
    ev("actions.requested", { turnId: "t1", actions: [{ kind: "tool-call", callId: "c1", toolName: "create_quote", input: { title: "100 Example St", phone: "+13055550199" } }] }, 200),
    ev("message.completed", { turnId: "t1", finishReason: "tool-calls", message: "Let me draft that." }, 250),
    ev("action.result", { turnId: "t1", status: "completed", result: { kind: "tool-result", callId: "c1", toolName: "create_quote", output: { quoteId: "q1" } } }, 1450),
    ev("actions.requested", { turnId: "t1", actions: [{ kind: "tool-call", callId: "c2", toolName: "get_quote", input: { quoteId: "nope" } }] }, 1500),
    ev("action.result", { turnId: "t1", status: "completed", result: { kind: "tool-result", callId: "c2", toolName: "get_quote", output: { error: "QUOTE_NOT_FOUND: No quote has that id." } } }, 1520),
    ev("message.completed", { turnId: "t1", finishReason: "stop", message: "Here's the quote." }, 1600),
    ev("turn.completed", { turnId: "t1", sequence: 9 }, 1700),
    ev("step.completed", { turnId: "t1" }, 1710),
  ];
  for (const e of events) await persistEvent(e, session);
  // A re-read event is stored once.
  await persistEvent(events[1], session);

  const stored = await rows();
  assert.deepEqual(
    stored.map((r) => [r.kind, r.toolName, r.status]),
    [
      ["turn.started", null, null],
      ["message.received", null, null],
      ["tool.started", "create_quote", null],
      ["tool.completed", "create_quote", "ok"],
      ["tool.started", "get_quote", null],
      ["tool.completed", "get_quote", "error"],
      ["message.completed", null, null],
      ["turn.completed", null, "completed"],
    ],
  );
  assert.ok(stored.every((r) => r.orgId === TEST_ORG && r.conversationId === thread.id && r.memberId === m.id && r.eveSessionId === "ses_a"));
  assert.ok(stored.every((r) => r.deliveryId === "dlv_1" && r.data.origin === "text"));
  assert.equal(stored[1].data.text, "quote 100 Example St");
  assert.equal(stored[1].data.files, 1);
  assert.deepEqual(stored[2].data.input, { title: "100 Example St", phone: "[redacted]" });
  assert.equal(stored[3].durationMs, 1250);
  assert.equal(stored[5].data.error, "QUOTE_NOT_FOUND");
  assert.equal(stored[6].data.text, "Here's the quote.");

  assert.equal(await deliveryReachedEve(TEST_ORG, "dlv_1"), true);
  assert.equal(await deliveryReachedEve(TEST_ORG, "dlv_other"), false);
  assert.deepEqual(await activitySummary(TEST_ORG, new Date(at(-60_000))), { turns: 1, failed: 0, tools: 2, toolErrors: 1 });
  const activity = await activityFor(TEST_ORG);
  assert.equal(activity[0].kind, "turn.completed");
  assert.equal(activity.find((r) => r.kind === "tool.completed" && r.status === "error")?.error, "QUOTE_NOT_FOUND");
  assert.equal(activity[0].memberName, "Pat Example");
});

withTestDb("a session that isn't the conversation's is refused and logged, and other businesses' rows can't be named", async () => {
  const { member: m, phone } = await member();
  await upsertThread(TEST_ORG, m.id, "ses_current");
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    // An old session (the thread moved on), and a web turn naming a conversation that isn't on this session.
    assert.deepEqual(await persistEvent(ev("turn.started", { turnId: "t1" }), { id: "ses_old", auth: memberAuth(m, phone) }), { recorded: 0 });
    const web = { authenticator: APP_WEB, principalId: "user_1", attributes: { orgId: TEST_ORG, memberId: m.id, conversationId: "conv_nope" } };
    assert.deepEqual(await persistEvent(ev("turn.started", { turnId: "t2" }), { id: "ses_current", auth: web }), { recorded: 0 });
    // Another business's auth can't reach this business's thread.
    await db().insert(organization).values({ id: "org_b", name: "B", slug: "b" });
    const forged = { ...memberAuth(m, phone), attributes: { ...memberAuth(m, phone).attributes, orgId: "org_b" } };
    assert.deepEqual(await persistEvent(ev("turn.started", { turnId: "t3" }), { id: "ses_current", auth: forged }), { recorded: 0 });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 3);
  assert.equal((await rows()).length, 0);
  // No member (a schedule, local dev's owner fallback) and subagent sessions record nothing, silently.
  assert.deepEqual(await persistEvent(ev("turn.started", { turnId: "t4" }), { id: "ses_current", auth: null }), { recorded: 0 });
  assert.deepEqual(
    await persistEvent(ev("turn.started", { turnId: "t5" }), { id: "ses_current", auth: memberAuth(m, phone), parent: { id: "p" } }),
    { recorded: 0 },
  );
});

withTestDb("a web turn in a job is recorded under the job; a running turn and pruning", async () => {
  const { member: m } = await member();
  await upsertThread(TEST_ORG, m.id, "ses_thread");
  await db().insert(conversations).values({ id: "job_1", orgId: TEST_ORG, memberId: m.id, kind: "job", title: "100 Example St", eveSessionId: "ses_job" });
  const web = { authenticator: APP_WEB, principalId: "user_1", attributes: { orgId: TEST_ORG, memberId: m.id, conversationId: "job_1" } };
  await persistEvent(ev("turn.started", { turnId: "t1" }), { id: "ses_job", auth: web });
  const [job] = await db().select().from(conversationEvents).where(eq(conversationEvents.conversationId, "job_1"));
  assert.equal(job.data.origin, "web");

  // A turn in the thread that started and hasn't ended is running; once it ends, it isn't.
  const thread = { id: "ses_thread", auth: { authenticator: "photon-imessage", principalId: `member:${m.id}`, attributes: { orgId: TEST_ORG, memberId: m.id } } };
  const started = ev("turn.started", { turnId: "t2" });
  await persistEvent(started, thread);
  const now = new Date(new Date(started.meta.at).getTime() + 1000);
  assert.equal(await threadTurnRunning(TEST_ORG, m.id, now), true);
  assert.equal(await threadTurnRunning(TEST_ORG, m.id, new Date(now.getTime() + 60 * 60_000)), false);
  await persistEvent(ev("turn.failed", { turnId: "t2", code: "MODEL_ERROR", message: "boom" }), thread);
  assert.equal(await threadTurnRunning(TEST_ORG, m.id, now), false);

  assert.equal(await pruneConversationEvents(new Date(Date.parse(at(0)) + 179 * 24 * 60 * 60_000)), 0);
  assert.equal(await pruneConversationEvents(new Date(Date.parse(at(0)) + 181 * 24 * 60 * 60_000)), 3);
});
