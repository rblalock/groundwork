import assert from "node:assert/strict";
import { test } from "node:test";
import { turnTraces } from "../schema/schema";
import { memberAuth } from "./channel-dispatch";
import type { StreamEvent } from "./conversation-events";
import { upsertThread } from "./conversations";
import { db } from "./db";
import { addPhone, createMember } from "./members";
import { TEST_ORG, withTestDb } from "./test-db";
import { capped, listTraces, pruneTurnTraces, recordTraceEvent, traceFor } from "./turn-traces";

let n = 0;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 18, 15, 0, 0) + ms).toISOString();
function ev(type: string, data: Record<string, unknown>, ms?: number): StreamEvent {
  n += 1;
  return { type, data, meta: { id: `evt_${String(n).padStart(4, "0")}_${type}`, at: at(ms ?? n * 1000) } };
}

async function member(phone = "+13055550100") {
  const m = await createMember({ orgId: TEST_ORG, name: "Pat Example", role: "owner" });
  const p = await addPhone(TEST_ORG, m.id, phone);
  return { member: m, phone: p };
}

/** One quoting turn: a step that calls a tool, then a step that answers. */
function quotingTurn(turnId: string) {
  return [
    ev("turn.started", { turnId, sequence: 1 }, 0),
    ev("step.started", { turnId, stepIndex: 0, modelId: "muse-wonder-1.0" }, 100),
    ev("actions.requested", { turnId, stepIndex: 0, actions: [{ kind: "tool-call", callId: "c1", toolName: "create_quote", input: { title: "x" } }] }, 200),
    ev("action.result", { turnId, stepIndex: 0, status: "completed", result: { kind: "tool-result", callId: "c1", toolName: "create_quote", output: { quoteId: "q1" } } }, 300),
    ev("message.completed", { turnId, stepIndex: 0, finishReason: "stop", message: "Here's the quote." }, 400),
    ev("step.completed", { turnId, stepIndex: 0, finishReason: "stop", usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0064 } }, 500),
    ev("turn.completed", { turnId, sequence: 9 }, 600),
  ];
}

test("capped keeps small values whole and cuts large ones to 32 KB of JSON", () => {
  assert.deepEqual(capped({ a: 1 }), { value: { a: 1 }, truncated: false });
  const big = capped({ text: "x".repeat(40_000) });
  assert.equal(big.truncated, true);
  assert.equal(typeof big.value, "string");
  assert.equal((big.value as string).length, 32 * 1024);
});

withTestDb("an eval's turn is traced with no conversation: model, steps in order, usage, and how it ended", async () => {
  const { member: m } = await member();
  const session = { id: "ses_eval", auth: { authenticator: "local-dev", principalId: "local", attributes: { orgId: TEST_ORG, memberId: m.id } } };
  const events = quotingTurn("t1");
  for (const e of events) await recordTraceEvent(e, session);
  // A re-delivered event is appended once.
  await recordTraceEvent(events[2], session);

  const rows = await db().select().from(turnTraces);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.match(row.id, /^trc_/);
  assert.equal(row.orgId, TEST_ORG);
  assert.equal(row.memberId, m.id);
  assert.equal(row.conversationId, null);
  assert.equal(row.source, "local");
  assert.equal(row.modelId, "muse-wonder-1.0");
  assert.equal(row.status, "completed");
  assert.equal(row.startedAt.toISOString(), at(0));
  assert.equal(row.finishedAt?.toISOString(), at(600));
  assert.deepEqual(
    row.steps.map((s) => [s.kind, s.stepIndex, s.toolName ?? null]),
    [
      ["step", 0, null],
      ["tool.call", 0, "create_quote"],
      ["tool.result", 0, "create_quote"],
      ["message", 0, null],
      ["step", 0, null],
    ],
  );
  assert.deepEqual(row.steps[1].input, { title: "x" });
  assert.deepEqual(row.steps[2].output, { quoteId: "q1" });
  assert.equal(row.steps[3].text, "Here's the quote.");
  assert.deepEqual(row.usage, { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0064 });

  const trace = await traceFor(TEST_ORG, "ses_eval", "t1");
  assert.equal(trace?.id, row.id);
  assert.equal(await traceFor("org_other", "ses_eval", "t1"), null);
  assert.equal((await listTraces(TEST_ORG)).length, 1);

  // Kept as long as conversation events, then dropped.
  const day = 24 * 60 * 60_000;
  assert.equal(await pruneTurnTraces(new Date(Date.parse(at(0)) + 179 * day)), 0);
  assert.equal(await pruneTurnTraces(new Date(Date.parse(at(0)) + 181 * day)), 1);
});

withTestDb("a thread's turn is traced under its conversation, usage summed over steps; subagent sessions are skipped", async () => {
  const { member: m, phone } = await member();
  const { conversation: thread } = await upsertThread(TEST_ORG, m.id, "ses_t");
  const session = { id: "ses_t", auth: memberAuth(m, phone) };
  for (const e of quotingTurn("t1")) {
    await recordTraceEvent(e, session);
    if (e.type === "step.completed") {
      await recordTraceEvent(ev("step.completed", { turnId: "t1", stepIndex: 1, finishReason: "stop", usage: { inputTokens: 300, outputTokens: 20, costUsd: 0.0016 } }, 550), session);
    }
  }
  const trace = await traceFor(TEST_ORG, "ses_t", "t1");
  assert.equal(trace?.conversationId, thread.id);
  assert.equal(trace?.source, "text");
  assert.equal(trace?.usage?.inputTokens, 1500);
  assert.equal(trace?.usage?.outputTokens, 100);
  assert.ok(Math.abs((trace?.usage?.costUsd ?? 0) - 0.008) < 1e-9);
  assert.equal((await listTraces(TEST_ORG, { conversationId: thread.id })).length, 1);

  await recordTraceEvent(ev("turn.started", { turnId: "t2" }), { ...session, parent: { id: "ses_parent" } });
  assert.equal(await traceFor(TEST_ORG, "ses_t", "t2"), null);
  assert.equal((await db().select().from(turnTraces)).length, 1);
});
