// The model catalog and provider factory: which model, how much context, and the options every call sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextTokens, currentModel } from "./model-pricing";
import { modelProviderOptions, modelReady } from "./model-provider";

function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("model-provider: every call turns off stored items and sends the env's reasoning effort", () => {
  withEnv({ MODEL_REASONING_EFFORT: undefined }, () => {
    const options = modelProviderOptions();
    assert.equal(options.openai.store, false);
    assert.equal(options.openai.reasoningEffort, "medium");
    assert.equal(options.openai.forceReasoning, true);
  });
  withEnv({ MODEL_REASONING_EFFORT: "low" }, () => assert.equal(modelProviderOptions().openai.reasoningEffort, "low"));
  withEnv({ MODEL_REASONING_EFFORT: "high" }, () => assert.equal(modelProviderOptions("low").openai.reasoningEffort, "low"));
});

test("model-provider: Wonder by default, Spark when the fallback switch is on", () => {
  withEnv({ MODEL_ID: undefined, MODEL_FALLBACK_ID: undefined, MODEL_USE_FALLBACK: undefined }, () => {
    assert.equal(currentModel(), "muse-wonder-1.0");
  });
  withEnv({ MODEL_ID: undefined, MODEL_FALLBACK_ID: undefined, MODEL_USE_FALLBACK: "1" }, () => {
    assert.equal(currentModel(), "muse-spark-1.3");
  });
});

test("model-provider: context budget defaults to 200k and follows the env", () => {
  withEnv({ MODEL_CONTEXT_TOKENS: undefined }, () => assert.equal(contextTokens(), 200_000));
  withEnv({ MODEL_CONTEXT_TOKENS: "64000" }, () => assert.equal(contextTokens(), 64_000));
});

test("model-provider: ready only with a Meta Model API key", () => {
  withEnv({ META_MODEL_API_KEY: undefined }, () => assert.equal(modelReady(), false));
  withEnv({ META_MODEL_API_KEY: "test-key" }, () => assert.equal(modelReady(), true));
});
