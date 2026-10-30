import assert from "node:assert/strict";
import { conversationEvents, conversations } from "../schema/schema";
import type { TraceStep } from "../schema/types";
import type { TraceInput } from "./dataset";
import { recordsFor, withInputs } from "./dataset-source";
import { db } from "./db";
import { createMember, type Caller } from "./members";
import { saveItems } from "./pricebook";
import { approveQuote, createQuote, type Poster } from "./quotes";
import { TEST_ORG, withTestDb } from "./test-db";

const post: Poster = async () => ({ posted: true });

function trace(turnId: string, steps: TraceStep[]): TraceInput {
  return {
    id: `trc_${turnId}`,
    turnId,
    eveSessionId: "ses_1",
    source: "text",
    modelId: "muse-wonder-1.0",
    status: "completed",
    steps,
    startedAt: new Date("2026-10-20T14:00:00Z"),
    finishedAt: new Date("2026-10-20T14:01:00Z"),
    instructionsHash: null,
    vertical: null,
  };
}

withTestDb("recordsFor reads each quote a trace names, scoped to the business; withInputs fills a missing message", async () => {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat Ortega", role: "owner" });
  const pat: Caller = { orgId: TEST_ORG, memberId: member.id, name: "Pat Ortega", role: "owner", language: "en", phoneE164: "+15555550101" };
  const [mow] = await saveItems(TEST_ORG, [{ name: "Mowing", unitKind: "each", unitLabel: "yard", priceCents: 4500 }], pat.memberId);
  const quote = await createQuote({ title: "412 Oak St", lines: [{ itemId: mow.id, quantity: 1 }] }, pat, { post });
  await approveQuote(quote.quoteId, pat, { post });

  const steps: TraceStep[] = [
    { eventId: "e1", at: "2026-10-20T14:00:10Z", stepIndex: 0, kind: "tool.call", toolName: "create_quote", callId: "c1", input: { title: "412 Oak St" } },
    { eventId: "e2", at: "2026-10-20T14:00:20Z", stepIndex: 0, kind: "tool.result", toolName: "create_quote", callId: "c1", output: { quoteId: quote.quoteId } },
    { eventId: "e3", at: "2026-10-20T14:00:30Z", stepIndex: 1, kind: "tool.result", toolName: "get_quote", callId: "c2", output: { quoteId: "quo_elsewhere" } },
  ];
  const records = await recordsFor(TEST_ORG, [trace("t1", steps)]);
  assert.equal(records.quotes.length, 1);
  const [facts] = records.quotes;
  assert.equal(facts.quoteId, quote.quoteId);
  assert.equal(facts.status, "approved");
  assert.ok(facts.approvedAt);
  assert.equal(facts.revisionTimes.length, 1);
  assert.deepEqual(await recordsFor("org_other", [trace("t1", steps)]), { quotes: [] });

  const [thread] = await db()
    .insert(conversations)
    .values({ id: "cnv_1", orgId: TEST_ORG, memberId: member.id, kind: "thread", eveSessionId: "ses_1" })
    .returning();
  await db().insert(conversationEvents).values({
    id: "evt_msg",
    orgId: TEST_ORG,
    conversationId: thread.id,
    memberId: member.id,
    eveSessionId: "ses_1",
    turnId: "t1",
    kind: "message.received",
    data: { text: "Mow the front at 412 Oak St", files: 0 },
    createdAt: new Date("2026-10-20T14:00:00Z"),
  });
  const kept: TraceStep = { eventId: "e0", at: "2026-10-20T14:00:00Z", stepIndex: null, kind: "input", text: "already here" };
  const [filled, untouched, none] = await withInputs(TEST_ORG, [trace("t1", steps), trace("t2", [kept]), trace("t3", steps)]);
  assert.equal(filled.steps[0].kind, "input");
  assert.equal(filled.steps[0].text, "Mow the front at 412 Oak St");
  assert.equal(untouched.steps[0].text, "already here");
  assert.equal(none.steps.some((s) => s.kind === "input"), false);
});
