import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalReporter } from "eve/evals/reporters";
import type { StreamEvent } from "../../../core/conversation-events";
import { createMember } from "../../../core/members";
import { TEST_ORG, withTestDb } from "../../../core/test-db";
import { recordTraceEvent } from "../../../core/turn-traces";
import { captureReporter } from "./capture";

let n = 0;
function ev(type: string, data: Record<string, unknown>, at: string): StreamEvent {
  n += 1;
  return { type, data, meta: { id: `evt_${n}`, at } };
}

/** One turn: the member asks, the model answers. */
async function turn(sessionId: string, memberId: string, message: string, at: string) {
  const session = { id: sessionId, auth: { authenticator: "local-dev", principalId: "local", attributes: { orgId: TEST_ORG, memberId } } };
  for (const e of [
    ev("turn.started", { turnId: `${sessionId}_t1`, sequence: 1 }, at),
    ev("message.received", { turnId: `${sessionId}_t1`, sequence: 2, message }, at),
    ev("step.started", { turnId: `${sessionId}_t1`, stepIndex: 0, modelId: "muse-wonder-1.0" }, at),
    ev("message.completed", { turnId: `${sessionId}_t1`, stepIndex: 0, finishReason: "stop", message: "I quote jobs and book visits." }, at),
    ev("turn.completed", { turnId: `${sessionId}_t1`, sequence: 9 }, at),
  ]) {
    await recordTraceEvent(e, session);
  }
}

type Result = Parameters<EvalReporter["onEvalComplete"]>[0];
const result = (id: string, verdict: string, sessionId: string) =>
  ({ id, verdict, assertions: [], startedAt: "2026-10-20T14:00:00Z", completedAt: "2026-10-20T14:05:00Z", result: { sessionId, sessions: [] } }) as unknown as Result;

withTestDb("capture writes the turns of evals that passed, with each eval's id and verdict beside them", async () => {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat Ortega", role: "owner" });
  await turn("ses_pass", member.id, "what can you do?", "2026-10-20T14:01:00Z");
  await turn("ses_fail", member.id, "what can't you do?", "2026-10-20T14:02:00Z");

  const dir = await mkdtemp(join(tmpdir(), "capture-"));
  const reporter = captureReporter(dir);
  await reporter.onRunStart([], {} as never);
  await reporter.onEvalComplete(result("answers", "passed", "ses_pass"));
  await reporter.onEvalComplete(result("refuses", "failed", "ses_fail"));
  await reporter.onRunComplete({} as never);

  const [run] = await readdir(dir);
  const read = async (name: string) => (await readFile(join(dir, run, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const openai = await read("dataset.openai.jsonl");
  const llama = await read("dataset.llama.jsonl");
  const meta = await read("dataset.meta.jsonl");
  assert.equal(openai.length, 1);
  assert.equal(llama.length, 1);
  assert.deepEqual(
    openai[0].messages.slice(1).map((m: { role: string; content: string }) => [m.role, m.content]),
    [
      ["user", "what can you do?"],
      ["assistant", "I quote jobs and book visits."],
    ],
  );
  assert.ok(openai[0].tools.some((t: { function: { name: string } }) => t.function.name === "create_quote"));
  assert.equal(meta[0].evalId, "answers");
  assert.equal(meta[0].verdict, "passed");
  assert.equal(meta[0].matchedBy, "session");
  assert.deepEqual(meta[0].labels, ["answered"]);
});
