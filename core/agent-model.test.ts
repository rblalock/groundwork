// An agent step's model: which Meta model it calls, the context budget compaction reads, and its options.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stepModel } from "./agent-model";

const ctx = { session: { id: "ses_1", auth: {} } };
const event = { data: { turnId: "turn_1", stepIndex: 0 } };

function withFallback(value: string | undefined, run: () => void) {
  const saved = process.env.MODEL_USE_FALLBACK;
  if (value === undefined) delete process.env.MODEL_USE_FALLBACK;
  else process.env.MODEL_USE_FALLBACK = value;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.MODEL_USE_FALLBACK;
    else process.env.MODEL_USE_FALLBACK = saved;
  }
}

test("agent-model: a step runs on Wonder with the app's context budget, not the model's full window", () => {
  withFallback(undefined, () => {
    const step = stepModel(event, ctx);
    assert.equal(step.model.modelId, "muse-wonder-1.0");
    assert.equal(step.modelContextWindowTokens, 200_000);
    assert.equal(step.modelOptions.providerOptions.openai.store, false);
    assert.equal(step.reasoning, "medium");
  });
});

test("agent-model: the fallback switch moves steps to Spark", () => {
  withFallback("1", () => assert.equal(stepModel(event, ctx).model.modelId, "muse-spark-1.3"));
});
